/**
 * A colour for any block name, including ones nobody has ever listed.
 *
 * The map used to be a lookup table of about a hundred blocks with a hash of
 * the name as the fallback. Measured against the real worlds on this machine,
 * that fallback was covering 51% of the visible surface on Lobby and 45% on the
 * modpack - which is why the map was full of lilac buildings and pink ground.
 * `dark_prismarine` hashed to purple, `dark_oak_slab` to purple, and
 * `short_grass` - vanilla's own 1.20.3 rename of `grass`, which the table still
 * called by its old name - hashed to purple too.
 *
 * Listing another hundred blocks would have fixed those three and broken again
 * on the next mod. Minecraft block ids are systematic, so this resolves them
 * systematically instead: strip the namespace, strip the shape, strip the
 * finish, and if what is left is still unknown, read the dye colour and the
 * material out of the name. A modded `biomesoplenty:jacaranda_leaves` comes out
 * leaf-green without anyone having heard of it.
 *
 * The hash is still there, at the end, for a name that resembles nothing.
 */

export type Rgb = [number, number, number];

/** Base blocks. Everything else is derived from these by the rules below. */
const BASE: Record<string, Rgb> = {
  // Terrain.
  grass_block: [106, 150, 68],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [144, 103, 76],
  podzol: [90, 63, 26],
  mud: [60, 52, 55],
  stone: [125, 125, 125],
  cobblestone: [122, 122, 122],
  andesite: [136, 136, 136],
  diorite: [188, 188, 188],
  granite: [149, 103, 86],
  tuff: [108, 109, 102],
  calcite: [223, 224, 220],
  dripstone: [134, 107, 92],
  deepslate: [80, 80, 84],
  bedrock: [60, 60, 60],
  sand: [219, 207, 163],
  red_sand: [190, 102, 33],
  sandstone: [216, 203, 155],
  red_sandstone: [186, 99, 30],
  gravel: [131, 127, 126],
  clay: [160, 166, 179],
  water: [63, 118, 228],
  lava: [217, 88, 22],
  snow: [248, 248, 248],
  powder_snow: [248, 250, 253],
  ice: [145, 183, 253],
  blue_ice: [116, 167, 253],
  farmland: [95, 62, 35],
  dirt_path: [148, 121, 65],
  moss: [89, 109, 45],
  amethyst: [134, 100, 191],

  // Wood, by species. The rules below turn these into planks, slabs, stairs,
  // fences and everything else without a line each.
  oak: [162, 130, 78],
  spruce: [114, 84, 48],
  birch: [196, 179, 123],
  jungle: [154, 110, 77],
  acacia: [168, 90, 50],
  dark_oak: [66, 43, 20],
  mangrove: [117, 54, 48],
  cherry: [216, 157, 154],
  bamboo: [193, 178, 63],
  crimson: [104, 57, 82],
  warped: [43, 104, 99],

  // Foliage, per species where it differs from plain green.
  leaves: [60, 143, 42],
  spruce_leaves: [47, 94, 47],
  birch_leaves: [124, 168, 84],
  cherry_leaves: [232, 158, 186],
  azalea_leaves: [92, 133, 51],
  flowering_azalea_leaves: [122, 128, 66],
  mangrove_leaves: [59, 122, 41],
  grass: [95, 148, 60],
  short_grass: [95, 148, 60],
  tall_grass: [95, 148, 60],
  fern: [88, 140, 55],
  large_fern: [88, 140, 55],
  moss_block: [89, 109, 45],
  vine: [58, 116, 35],
  lily_pad: [32, 128, 48],
  seagrass: [58, 126, 65],
  kelp: [69, 120, 46],
  sugar_cane: [148, 192, 101],
  bamboo_plant: [125, 165, 51],
  cactus: [86, 125, 41],
  pink_petals: [232, 158, 186],
  wheat: [188, 180, 92],
  carrots: [78, 143, 48],
  potatoes: [70, 138, 56],
  beetroots: [122, 138, 60],
  pumpkin: [198, 118, 23],
  melon: [111, 145, 40],
  hay_block: [166, 136, 25],

  // Stone products.
  bricks: [150, 97, 83],
  stone_bricks: [122, 122, 122],
  mud_bricks: [137, 105, 80],
  prismarine: [99, 156, 151],
  dark_prismarine: [51, 91, 75],
  prismarine_bricks: [99, 171, 158],
  sea_lantern: [172, 199, 190],
  quartz: [235, 229, 222],
  purpur: [169, 125, 169],
  obsidian: [15, 10, 24],
  glowstone: [173, 139, 96],
  glass: [175, 213, 219],
  netherrack: [97, 38, 38],
  crimson_nylium: [130, 31, 31],
  warped_nylium: [22, 121, 101],
  soul_sand: [81, 62, 50],
  soul_soil: [76, 58, 47],
  nether_bricks: [44, 21, 26],
  red_nether_bricks: [69, 5, 6],
  nether_wart_block: [114, 3, 3],
  warped_wart_block: [20, 139, 141],
  basalt: [80, 80, 87],
  blackstone: [42, 35, 40],
  magma_block: [142, 62, 26],
  shroomlight: [240, 146, 70],
  ancient_debris: [67, 46, 42],
  end_stone: [219, 222, 158],
  chorus_plant: [93, 60, 93],
  chorus_flower: [149, 128, 149],
  copper: [192, 107, 79],
  iron_block: [220, 220, 220],
  gold_block: [246, 208, 61],
  diamond_block: [98, 219, 214],
  emerald_block: [42, 203, 88],
  netherite_block: [66, 60, 62],
  coal_block: [16, 15, 15],
  redstone_block: [175, 24, 5],
  lapis_block: [30, 67, 140],
  bone_block: [229, 225, 203],
  sponge: [195, 192, 74],
  slime_block: [111, 192, 91],
  honey_block: [251, 179, 42],
  scaffolding: [190, 152, 86],
  ladder: [126, 100, 57],
  cobweb: [225, 232, 234],
  torch: [255, 200, 90],
  campfire: [200, 120, 50],
  chest: [162, 130, 78],
  barrel: [126, 100, 57],
  crafting_table: [141, 100, 60],
  furnace: [112, 112, 112],
  bookshelf: [156, 125, 76],
  hopper: [70, 70, 74],
};

/** Minecraft's sixteen dyes, at full strength. */
const DYES: Record<string, Rgb> = {
  white: [233, 236, 236],
  orange: [240, 118, 19],
  magenta: [189, 68, 179],
  light_blue: [58, 175, 217],
  yellow: [248, 197, 39],
  lime: [112, 185, 25],
  pink: [237, 141, 172],
  gray: [62, 68, 71],
  light_gray: [142, 142, 134],
  cyan: [21, 137, 145],
  purple: [126, 61, 181],
  blue: [44, 46, 143],
  brown: [114, 71, 40],
  green: [84, 109, 27],
  red: [160, 39, 34],
  black: [20, 21, 25],
};

/**
 * How each dyed material shifts its dye.
 *
 * Terracotta is fired clay, so it is muted and warmed; glass is thin, so it is
 * pale; concrete powder is loose and lighter than the set block. Getting these
 * relationships right is what stops sixteen concretes and sixteen terracottas
 * from looking like the same sixteen colours.
 */
const MATERIAL_SHIFT: Record<string, { mix: Rgb; amount: number; scale: number }> = {
  concrete: { mix: [255, 255, 255], amount: 0, scale: 1 },
  concrete_powder: { mix: [255, 255, 255], amount: 0.18, scale: 1 },
  terracotta: { mix: [150, 92, 66], amount: 0.45, scale: 0.95 },
  glazed_terracotta: { mix: [200, 180, 160], amount: 0.3, scale: 1 },
  stained_glass: { mix: [255, 255, 255], amount: 0.35, scale: 1 },
  wool: { mix: [255, 255, 255], amount: 0.05, scale: 1 },
  carpet: { mix: [255, 255, 255], amount: 0.05, scale: 1 },
  shulker_box: { mix: [120, 90, 130], amount: 0.35, scale: 0.9 },
  bed: { mix: [255, 255, 255], amount: 0.1, scale: 1 },
  candle: { mix: [235, 225, 200], amount: 0.3, scale: 1 },
  banner: { mix: [255, 255, 255], amount: 0.05, scale: 1 },
};

function mix([r, g, b]: Rgb, [r2, g2, b2]: Rgb, amount: number, scale = 1): Rgb {
  const blend = (a: number, c: number) =>
    Math.max(0, Math.min(255, Math.round((a + (c - a) * amount) * scale)));
  return [blend(r, r2), blend(g, g2), blend(b, b2)];
}

/**
 * Shapes a block can take. Stripped from the end, because a slab of something
 * is the colour of that something.
 */
const SHAPES = [
  "_stairs",
  "_slab",
  "_wall",
  "_fence_gate",
  "_fence",
  "_pane",
  "_pressure_plate",
  "_button",
  "_trapdoor",
  "_door",
  "_wall_sign",
  "_hanging_sign",
  "_sign",
  "_planks",
  "_log",
  "_wood",
  "_stem",
  "_hyphae",
  "_block",
  "_bricks",
  "_brick",
  "_tiles",
  "_tile",
  "_pillar",
  "_lamp",
  "_bulb",
  "_grate",
  "_ore",
];

/** Finishes applied to a base material, stripped from the front. */
const FINISHES = [
  "polished_",
  "smooth_",
  "chiseled_",
  "cracked_",
  "mossy_",
  "cut_",
  "waxed_",
  "exposed_",
  "weathered_",
  "oxidized_",
  "infested_",
  "stripped_",
  "deepslate_",
  "nether_",
  "raw_",
  "block_of_",
];

function lookup(name: string): Rgb | null {
  return BASE[name] ?? null;
}

/**
 * Dyed materials: `pink_concrete`, `light_gray_terracotta`,
 * `white_stained_glass_pane`. The longest dye name is matched first so
 * `light_gray` never resolves as `gray`.
 */
const DYE_NAMES = Object.keys(DYES).sort((a, b) => b.length - a.length);

function dyed(name: string): Rgb | null {
  for (const dye of DYE_NAMES) {
    if (!name.startsWith(`${dye}_`)) continue;
    const material = name.slice(dye.length + 1);
    const shift = MATERIAL_SHIFT[material];
    if (shift) return mix(DYES[dye], shift.mix, shift.amount, shift.scale);
    // A dyed something we have no rule for still gets its dye rather than a
    // hash: the colour is the informative half of the name.
    return DYES[dye];
  }
  return null;
}

/**
 * Last resort before the hash: what kind of thing is this, by its name?
 *
 * This is what carries modded blocks. `biomesoplenty:pine_leaves` has already
 * lost its namespace by the time it arrives here, and `_leaves` is enough to
 * know it should be green.
 */
const FAMILIES: [RegExp, Rgb][] = [
  [/leaves$|leaf$/, [60, 143, 42]],
  [/sapling$|_bush$|_vine$|vines$|moss|fern$|grass$|_roots$|lichen$/, [88, 140, 55]],
  [/flower$|tulip$|orchid$|daisy$|poppy$|dandelion$|lilac$|peony$|lavender$|petals$|allium$|cornflower$/, [148, 168, 90]],
  [/mushroom|fungus$/, [176, 102, 88]],
  [/_log$|_wood$|_stem$|_hyphae$|_branch$/, [110, 84, 52]],
  [/planks$|_door$|_ladder$|crate$|_barrel$/, [162, 130, 78]],
  [/_ore$/, [125, 125, 125]],
  [/deepslate/, [80, 80, 84]],
  [/sandstone$|_sand$/, [216, 203, 155]],
  [/_ice$|icicle/, [145, 183, 253]],
  [/snow/, [248, 248, 248]],
  [/water|_bubble/, [63, 118, 228]],
  [/lava|magma/, [217, 88, 22]],
  [/bricks?$/, [150, 97, 83]],
  [/stone$|cobble|rock$|gravel$|andesite|granite|diorite|basalt|tuff$/, [125, 125, 125]],
  [/glass/, [175, 213, 219]],
  [/wool$|carpet$/, [200, 200, 200]],
  [/dirt$|soil$|mud$|clay$|loam$/, [134, 96, 67]],
  [/crop$|wheat$|_onions$|_carrots$|potatoes$|beetroots$/, [170, 170, 80]],
  [/cobweb|webbing$|_web$|spider_egg$/, [225, 232, 234]],
  [/hopper$|_rail$|rails$|piston$|anvil$|cauldron$/, [70, 70, 74]],
];

/** Stable pseudo-colour so a name resembling nothing is at least consistent. */
function hashed(name: string): Rgb {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return [((h >>> 16) & 0x7f) + 80, ((h >>> 8) & 0x7f) + 80, (h & 0x7f) + 80];
}

const cache = new Map<string, Rgb>();

export function colourOf(block: string): Rgb {
  const hit = cache.get(block);
  if (hit) return hit;
  const found = resolve(block);
  cache.set(block, found);
  return found;
}

function resolve(original: string): Rgb {
  // Namespace first: a mod's block is named like a vanilla one behind the colon,
  // and everything below works on the bare name.
  let name = original.includes(":") ? original.slice(original.indexOf(":") + 1) : original;

  let direct = lookup(name) ?? dyed(name);
  if (direct) return direct;

  // Shapes and finishes, repeatedly: `polished_deepslate_brick_stairs` needs
  // three passes before it is just `deepslate`.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const shape of SHAPES) {
      if (name.length > shape.length && name.endsWith(shape)) {
        name = name.slice(0, -shape.length);
        changed = true;
        break;
      }
    }
    for (const finish of FINISHES) {
      if (name.length > finish.length && name.startsWith(finish)) {
        name = name.slice(finish.length);
        changed = true;
        break;
      }
    }
    if (!changed) break;
    direct = lookup(name) ?? dyed(name);
    if (direct) return direct;
  }

  for (const [pattern, colour] of FAMILIES) {
    if (pattern.test(original) || pattern.test(name)) return colour;
  }
  return hashed(original);
}
