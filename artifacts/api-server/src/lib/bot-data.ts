/**
 * Static Minecraft game knowledge: which blocks drop what, tool/armor tiers,
 * hostile mobs, tree types, food safety and item classification.
 *
 * Kept separate from the BotManager so the tables stay easy to extend.
 */

// ---------------------------------------------------------------------------
// Mining
// ---------------------------------------------------------------------------

export interface ResourceInfo {
  blocks: string[];
  /** Minimum pickaxe harvest tier needed for the block to drop anything. */
  minPickaxeTier: number;
  /** Recommended pickaxe wording for error messages. */
  requiredPickaxe: string;
}

export const RESOURCES: Record<string, ResourceInfo> = {
  coal: { blocks: ["coal_ore", "deepslate_coal_ore"], minPickaxeTier: 0, requiredPickaxe: "any pickaxe" },
  iron: { blocks: ["iron_ore", "deepslate_iron_ore"], minPickaxeTier: 1, requiredPickaxe: "a stone pickaxe or better" },
  copper: { blocks: ["copper_ore", "deepslate_copper_ore"], minPickaxeTier: 1, requiredPickaxe: "a stone pickaxe or better" },
  gold: { blocks: ["gold_ore", "deepslate_gold_ore", "nether_gold_ore"], minPickaxeTier: 2, requiredPickaxe: "an iron pickaxe or better" },
  redstone: { blocks: ["redstone_ore", "deepslate_redstone_ore"], minPickaxeTier: 2, requiredPickaxe: "an iron pickaxe or better" },
  lapis: { blocks: ["lapis_ore", "deepslate_lapis_ore"], minPickaxeTier: 1, requiredPickaxe: "a stone pickaxe or better" },
  diamond: { blocks: ["diamond_ore", "deepslate_diamond_ore"], minPickaxeTier: 2, requiredPickaxe: "an iron pickaxe or better" },
  emerald: { blocks: ["emerald_ore", "deepslate_emerald_ore"], minPickaxeTier: 2, requiredPickaxe: "an iron pickaxe or better" },
  stone: { blocks: ["stone"], minPickaxeTier: 0, requiredPickaxe: "any pickaxe" },
  obsidian: { blocks: ["obsidian"], minPickaxeTier: 3, requiredPickaxe: "a diamond pickaxe or better" },
  ancient_debris: { blocks: ["ancient_debris"], minPickaxeTier: 3, requiredPickaxe: "a diamond pickaxe or better" },
};

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeTypeConfig {
  logs: string[];
  sapling: string;
  soil: string[];
}

const SOIL = ["grass_block", "dirt", "podzol", "coarse_dirt", "rooted_dirt"];

export const TREE_TYPES: Record<string, TreeTypeConfig> = {
  oak: { logs: ["oak_log", "oak_wood"], sapling: "oak_sapling", soil: SOIL },
  birch: { logs: ["birch_log", "birch_wood"], sapling: "birch_sapling", soil: SOIL },
  spruce: { logs: ["spruce_log", "spruce_wood"], sapling: "spruce_sapling", soil: SOIL },
  jungle: { logs: ["jungle_log", "jungle_wood"], sapling: "jungle_sapling", soil: SOIL },
  acacia: { logs: ["acacia_log", "acacia_wood"], sapling: "acacia_sapling", soil: SOIL },
  dark_oak: { logs: ["dark_oak_log", "dark_oak_wood"], sapling: "dark_oak_sapling", soil: SOIL },
  mangrove: { logs: ["mangrove_log", "mangrove_wood"], sapling: "mangrove_propagule", soil: ["mud", ...SOIL] },
  cherry: { logs: ["cherry_log", "cherry_wood"], sapling: "cherry_sapling", soil: SOIL },
  pale_oak: { logs: ["pale_oak_log", "pale_oak_wood"], sapling: "pale_oak_sapling", soil: SOIL },
};

export const ALL_LOG_NAMES = Object.values(TREE_TYPES).flatMap((t) => t.logs);

export function detectTreeType(blockName: string): TreeTypeConfig | null {
  for (const config of Object.values(TREE_TYPES)) {
    if (config.logs.some((l) => blockName === l)) return config;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mobs
// ---------------------------------------------------------------------------

export const HOSTILE_MOBS = [
  "zombie", "zombie_villager", "skeleton", "creeper", "spider", "cave_spider",
  "enderman", "witch", "pillager", "vindicator", "evoker", "vex", "phantom",
  "drowned", "husk", "stray", "bogged", "blaze", "ghast", "slime",
  "magma_cube", "zombified_piglin", "piglin_brute", "hoglin", "zoglin",
  "ravager", "warden", "silverfish", "endermite", "guardian",
  "elder_guardian", "shulker", "wither_skeleton", "breeze",
];

export function isHostileMob(entityName: string | undefined): boolean {
  if (!entityName) return false;
  const name = entityName.toLowerCase();
  return HOSTILE_MOBS.some((h) => name === h || name.endsWith(`_${h}`) || name.includes(h));
}

// ---------------------------------------------------------------------------
// Tools, weapons, armor
// ---------------------------------------------------------------------------

const MATERIAL_TIER: Record<string, number> = {
  wooden: 0,
  golden: 0, // gold harvests like wood (but digs fast)
  stone: 1,
  iron: 2,
  diamond: 3,
  netherite: 4,
};

/** Harvest tier of a pickaxe item name, or -1 when it isn't a pickaxe. */
export function pickaxeTier(itemName: string): number {
  if (!itemName.endsWith("_pickaxe")) return -1;
  const material = itemName.slice(0, -"_pickaxe".length);
  return MATERIAL_TIER[material] ?? -1;
}

/** Generic gear score (higher = better) used to pick the best tool/weapon. */
export function gearScore(itemName: string): number {
  const name = itemName.toLowerCase();
  let material = 0;
  for (const [mat, tier] of Object.entries(MATERIAL_TIER)) {
    if (name.startsWith(`${mat}_`)) material = tier + 1;
  }
  // Golden digs/swings fast but is fragile — nudge it above wood, below stone.
  if (name.startsWith("golden_")) material = 1.5;
  return material;
}

export function findBestBySuffix<T extends { name: string }>(
  items: T[],
  suffixes: string[],
): T | null {
  let best: T | null = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const idx = suffixes.findIndex((s) => item.name === s || item.name.endsWith(s));
    if (idx === -1) continue;
    // Earlier suffix groups outrank later ones (e.g. swords before axes).
    const score = (suffixes.length - idx) * 100 + gearScore(item.name);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }
  return best;
}

export type ArmorSlotName = "head" | "torso" | "legs" | "feet";

/** Inventory slot index for each armor destination (player window layout). */
export const ARMOR_WINDOW_SLOT: Record<ArmorSlotName, number> = {
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
};

export function armorSlotFor(itemName: string): ArmorSlotName | null {
  const n = itemName.toLowerCase();
  if (n.endsWith("_helmet") || n === "turtle_helmet" || n.endsWith("_cap")) return "head";
  if (n.endsWith("_chestplate") || n.endsWith("_tunic") || n === "elytra") return "torso";
  if (n.endsWith("_leggings") || n.endsWith("_pants")) return "legs";
  if (n.endsWith("_boots")) return "feet";
  return null;
}

const ARMOR_MATERIAL_SCORE: Record<string, number> = {
  leather: 1,
  golden: 2,
  chainmail: 3,
  iron: 4,
  turtle: 4,
  diamond: 5,
  netherite: 6,
};

export function armorScore(itemName: string): number {
  const n = itemName.toLowerCase();
  if (n === "elytra") return 0.5; // fun, but no protection — only wear if torso is empty
  for (const [mat, score] of Object.entries(ARMOR_MATERIAL_SCORE)) {
    if (n.startsWith(`${mat}_`)) return score;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Food
// ---------------------------------------------------------------------------

/** Foods the auto-eater must never touch (poison / random teleport). */
export const BAD_FOODS = new Set([
  "rotten_flesh",
  "spider_eye",
  "poisonous_potato",
  "pufferfish",
  "chorus_fruit",
]);

// ---------------------------------------------------------------------------
// Item classification (dashboard inventory + drop/deposit filtering)
// ---------------------------------------------------------------------------

export type ItemCategory = "armor" | "weapon" | "tool" | "food" | "block" | "other";

export interface ItemClassification {
  category: ItemCategory;
  isArmor: boolean;
  isTool: boolean;
  isFood: boolean;
}

const WEAPON_SUFFIXES = ["_sword", "_mace"];
const WEAPON_NAMES = new Set(["bow", "crossbow", "trident", "mace"]);
const TOOL_SUFFIXES = ["_pickaxe", "_axe", "_shovel", "_hoe"];
const TOOL_NAMES = new Set([
  "shears", "flint_and_steel", "fishing_rod", "shield",
  "brush", "spyglass", "lead", "name_tag",
]);

/**
 * Classify an item by registry name. Uses exact suffix matches to avoid the
 * classic substring bugs (e.g. "bowl" matching "bow").
 * `blockNames`/`foodNames` come from minecraft-data when available.
 */
export function classifyItem(
  itemName: string,
  opts?: { blockNames?: Set<string>; foodNames?: Set<string> },
): ItemClassification {
  const name = itemName.toLowerCase().replace(/^minecraft:/, "");
  const isArmor = armorSlotFor(name) !== null;
  const isWeapon = WEAPON_NAMES.has(name) || WEAPON_SUFFIXES.some((s) => name.endsWith(s));
  const isToolGear =
    TOOL_NAMES.has(name) || TOOL_SUFFIXES.some((s) => name.endsWith(s));
  const isFood = opts?.foodNames?.has(name) ?? false;
  const isBlock = opts?.blockNames?.has(name) ?? false;

  let category: ItemCategory = "other";
  if (isArmor) category = "armor";
  else if (isWeapon) category = "weapon";
  else if (isToolGear) category = "tool";
  else if (isFood) category = "food";
  else if (isBlock) category = "block";

  return {
    category,
    isArmor,
    isTool: isToolGear || isWeapon,
    isFood,
  };
}

// ---------------------------------------------------------------------------
// Blocks the bot interacts with
// ---------------------------------------------------------------------------

const WOOD_TYPES = [
  "oak", "spruce", "birch", "jungle", "acacia", "dark_oak",
  "mangrove", "cherry", "crimson", "warped", "bamboo", "pale_oak",
];

export const BUTTON_AND_LEVER_BLOCKS = [
  "lever",
  "stone_button",
  "polished_blackstone_button",
  ...WOOD_TYPES.map((w) => `${w}_button`),
];

export const BED_BLOCKS = [
  "white_bed", "orange_bed", "magenta_bed", "light_blue_bed", "yellow_bed",
  "lime_bed", "pink_bed", "gray_bed", "light_gray_bed", "cyan_bed",
  "purple_bed", "blue_bed", "brown_bed", "green_bed", "red_bed", "black_bed",
];

export const CONTAINER_BLOCKS = [
  "chest", "trapped_chest", "barrel", "ender_chest",
  "shulker_box",
  ...[
    "white", "orange", "magenta", "light_blue", "yellow", "lime", "pink",
    "gray", "light_gray", "cyan", "purple", "blue", "brown", "green",
    "red", "black",
  ].map((c) => `${c}_shulker_box`),
];

/** Preferred throw-away blocks for pillaring / scaffolding. */
export const SCAFFOLD_BLOCKS = [
  "dirt", "cobblestone", "netherrack", "cobbled_deepslate", "stone",
  "andesite", "diorite", "granite", "sand", "gravel", "mud",
];
