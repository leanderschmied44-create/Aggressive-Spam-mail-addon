import { world, system, ItemStack, BlockPermutation } from "@minecraft/server";

// List of vanilla wooden doors
const WOODEN_DOOR_IDS = new Set([
  "minecraft:oak_door",
  "minecraft:spruce_door",
  "minecraft:birch_door",
  "minecraft:jungle_door",
  "minecraft:acacia_door",
  "minecraft:dark_oak_door",
  "minecraft:mangrove_door",
  "minecraft:cherry_door",
  "minecraft:bamboo_door",
  "minecraft:crimson_door",
  "minecraft:warped_door"
]);

// Track placed mailboxes: array of { dimensionId, x, y, z, lastProcessedDay }
// Stored in dynamic property for persistence
const MAILBOXES_KEY = "AggressiveSpam:Mailboxes";

function getCurrentDay() {
  try {
    return world.getDay();
  } catch (e) {
    return 0;
  }
}

function getMailboxes() {
  try {
    const data = world.getDynamicProperty(MAILBOXES_KEY);
    if (typeof data === "string") {
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Error reading mailboxes property:", e);
  }
  return [];
}

function saveMailboxes(mailboxes) {
  try {
    world.setDynamicProperty(MAILBOXES_KEY, JSON.stringify(mailboxes));
  } catch (e) {
    console.error("Error saving mailboxes property:", e);
  }
}

function addMailbox(dimensionId, x, y, z) {
  const mailboxes = getMailboxes();
  const exists = mailboxes.some(
    (m) => m.dimensionId === dimensionId && m.x === x && m.y === y && m.z === z
  );
  if (!exists) {
    const currentDay = getCurrentDay();
    mailboxes.push({ dimensionId, x, y, z, lastProcessedDay: currentDay });
    saveMailboxes(mailboxes);
  }
}

function removeMailbox(dimensionId, x, y, z) {
  let mailboxes = getMailboxes();
  mailboxes = mailboxes.filter(
    (m) => !(m.dimensionId === dimensionId && m.x === x && m.y === y && m.z === z)
  );
  saveMailboxes(mailboxes);
}

/**
 * Calculates position in front of a placed door based on cardinal direction / facing.
 */
function getFrontPosition(blockLocation, directionFacing) {
  let { x, y, z } = blockLocation;
  const facingStr = String(directionFacing).toLowerCase();

  if (facingStr.includes("north") || directionFacing === 2) {
    z -= 1;
  } else if (facingStr.includes("south") || directionFacing === 0) {
    z += 1;
  } else if (facingStr.includes("west") || directionFacing === 1) {
    x -= 1;
  } else if (facingStr.includes("east") || directionFacing === 3) {
    x += 1;
  } else {
    z += 1;
  }
  return { x, y, z };
}

// Event 1: Placing a wooden door automatically crafts/places a mailbox in front of it.
world.afterEvents.playerPlaceBlock.subscribe((event) => {
  const { block, player } = event;
  if (!block) return;

  const typeId = block.typeId;
  if (WOODEN_DOOR_IDS.has(typeId)) {
    let facing = "south";
    try {
      const facingState = block.permutation.getState("facing_direction") ?? block.permutation.getState("minecraft:cardinal_direction");
      if (facingState !== undefined) {
        facing = facingState;
      }
    } catch (e) {
      // Ignore fallback
    }

    const frontPos = getFrontPosition(block.location, facing);
    const dimension = block.dimension;
    const targetBlock = dimension.getBlock(frontPos);

    if (targetBlock && (targetBlock.isAir || targetBlock.isLiquid)) {
      targetBlock.setPermutation(BlockPermutation.resolve("aggressive_spam:mailbox"));
      addMailbox(dimension.id, frontPos.x, frontPos.y, frontPos.z);
      if (player) {
        player.sendMessage("§c[Spam Mailbox] A mailbox was automatically placed in front of your wooden door! Be sure to clear it every morning!");
      }
    }
  } else if (typeId === "aggressive_spam:mailbox") {
    addMailbox(block.dimension.id, block.location.x, block.location.y, block.location.z);
  }
});

// Event 2: Also register if mailbox is placed in any other way
world.afterEvents.blockPlace.subscribe((event) => {
  const { block } = event;
  if (block && block.typeId === "aggressive_spam:mailbox") {
    addMailbox(block.dimension.id, block.location.x, block.location.y, block.location.z);
  }
});

/**
 * Fills mailbox with 20 unusable paper "junk letters" or explodes if uncleared.
 */
function processMorningSpam(mailboxRecord, currentDay) {
  const dimension = world.getDimension(mailboxRecord.dimensionId);
  if (!dimension) return;

  const blockLoc = { x: mailboxRecord.x, y: mailboxRecord.y, z: mailboxRecord.z };
  const block = dimension.getBlock(blockLoc);

  // If block is no longer a mailbox, unregister
  if (!block || block.typeId !== "aggressive_spam:mailbox") {
    removeMailbox(mailboxRecord.dimensionId, mailboxRecord.x, mailboxRecord.y, mailboxRecord.z);
    return;
  }

  // Find container block entity or container component (e.g. inventory)
  const containerComp = block.getComponent("minecraft:inventory") || block.getComponent("inventory");
  const container = containerComp ? containerComp.container : null;

  let isUncleared = false;

  if (container) {
    for (let i = 0; i < container.size; i++) {
      const item = container.getItem(i);
      if (item) {
        isUncleared = true;
        break;
      }
    }
  }

  // If the mailbox was not cleared from previous days, it overflows and explodes with TNT force!
  if (isUncleared && mailboxRecord.lastProcessedDay < currentDay) {
    dimension.createExplosion(blockLoc, 4.0, { causesFire: true, breaksBlocks: true });
    removeMailbox(mailboxRecord.dimensionId, mailboxRecord.x, mailboxRecord.y, mailboxRecord.z);
    world.sendMessage(`§4[SPAM OVERFLOW] A mailbox exploded at (${blockLoc.x}, ${blockLoc.y}, ${blockLoc.z}) because it wasn't cleared!`);
    return;
  }

  // Otherwise, fill up with 20 unusable paper "junk letters"
  if (container) {
    let remainingToAdd = 20;
    for (let i = 0; i < container.size && remainingToAdd > 0; i++) {
      const item = container.getItem(i);
      if (!item) {
        const toAdd = Math.min(64, remainingToAdd);
        container.setItem(i, new ItemStack("aggressive_spam:junk_letter", toAdd));
        remainingToAdd -= toAdd;
      } else if (item.typeId === "aggressive_spam:junk_letter" && item.amount < item.maxAmount) {
        const space = item.maxAmount - item.amount;
        const toAdd = Math.min(space, remainingToAdd);
        item.amount += toAdd;
        container.setItem(i, item);
        remainingToAdd -= toAdd;
      }
    }

    if (remainingToAdd > 0) {
      dimension.createExplosion(blockLoc, 4.0, { causesFire: true, breaksBlocks: true });
      removeMailbox(mailboxRecord.dimensionId, mailboxRecord.x, mailboxRecord.y, mailboxRecord.z);
      world.sendMessage(`§4[SPAM OVERFLOW] A mailbox overflowed and exploded at (${blockLoc.x}, ${blockLoc.y}, ${blockLoc.z})!`);
      return;
    }
  } else {
    // If container isn't present, drop 20 Junk Letters on top of mailbox as spam mail delivery!
    try {
      dimension.spawnItem(new ItemStack("aggressive_spam:junk_letter", 20), { x: blockLoc.x + 0.5, y: blockLoc.y + 1, z: blockLoc.z + 0.5 });
    } catch (e) {}
  }

  // Update last processed day
  let mailboxes = getMailboxes();
  const index = mailboxes.findIndex(
    (m) => m.dimensionId === mailboxRecord.dimensionId && m.x === mailboxRecord.x && m.y === mailboxRecord.y && m.z === mailboxRecord.z
  );
  if (index !== -1) {
    mailboxes[index].lastProcessedDay = currentDay;
    saveMailboxes(mailboxes);
  }
}

// Main morning check loop
system.runInterval(() => {
  try {
    const timeOfDay = world.getTimeOfDay(); // 0 to 24000 (0 is sunrise / morning)
    const currentDay = getCurrentDay();

    if (timeOfDay >= 0 && timeOfDay < 1000) {
      const mailboxes = getMailboxes();
      for (const m of mailboxes) {
        if (m.lastProcessedDay < currentDay) {
          processMorningSpam(m, currentDay);
        }
      }
    }
  } catch (e) {
    // Ignore errors during world load
  }
}, 40); // Check every 2 seconds (40 ticks)
