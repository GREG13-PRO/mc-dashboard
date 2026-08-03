package hu.mcdashboard.guard;

import java.util.EnumSet;
import java.util.Set;

import org.bukkit.GameMode;
import org.bukkit.Material;
import org.bukkit.block.Block;
import org.bukkit.block.BlockFace;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockBreakEvent;

/**
 * The x-ray signal: how much of what a player mined was never visible.
 *
 * Someone digging normally finds ore by running into it, so nearly everything
 * they break has had an exposed face towards a tunnel or a cave. Ore that was
 * sealed on all six sides was not found by looking at it. One such block means
 * nothing - a branch mine cuts into sealed ore constantly - so what is reported
 * is the ratio over a meaningful number of blocks, and only ever as a signal
 * for a human to judge.
 */
final class OreWatcher implements Listener {

    private static final Set<Material> ORES = EnumSet.of(
            Material.COAL_ORE, Material.DEEPSLATE_COAL_ORE,
            Material.IRON_ORE, Material.DEEPSLATE_IRON_ORE,
            Material.COPPER_ORE, Material.DEEPSLATE_COPPER_ORE,
            Material.GOLD_ORE, Material.DEEPSLATE_GOLD_ORE,
            Material.REDSTONE_ORE, Material.DEEPSLATE_REDSTONE_ORE,
            Material.LAPIS_ORE, Material.DEEPSLATE_LAPIS_ORE,
            Material.EMERALD_ORE, Material.DEEPSLATE_EMERALD_ORE,
            Material.DIAMOND_ORE, Material.DEEPSLATE_DIAMOND_ORE,
            Material.NETHER_GOLD_ORE, Material.NETHER_QUARTZ_ORE,
            Material.ANCIENT_DEBRIS);

    /** The ones worth going out of your way for, and so the ones worth weighing. */
    private static final Set<Material> VALUABLE = EnumSet.of(
            Material.DIAMOND_ORE, Material.DEEPSLATE_DIAMOND_ORE,
            Material.EMERALD_ORE, Material.DEEPSLATE_EMERALD_ORE,
            Material.ANCIENT_DEBRIS);

    private static final BlockFace[] FACES = {
            BlockFace.UP, BlockFace.DOWN, BlockFace.NORTH,
            BlockFace.SOUTH, BlockFace.EAST, BlockFace.WEST };

    /** Below this there is not enough mining to say anything at all. */
    private static final int MIN_ORES = 25;
    private static final double HIDDEN_RATIO_FLAG = 0.85;
    private static final int MIN_VALUABLE = 6;
    private static final double VALUABLE_RATIO_FLAG = 0.9;

    private final Guard guard;

    OreWatcher(Guard guard) {
        this.guard = guard;
    }

    @EventHandler(ignoreCancelled = true)
    public void onBreak(BlockBreakEvent event) {
        // Creative and spectator players are not the ones anyone is worried
        // about, and staff building would otherwise dominate the numbers.
        GameMode mode = event.getPlayer().getGameMode();
        if (mode != GameMode.SURVIVAL && mode != GameMode.ADVENTURE) return;

        PlayerStats stats = guard.statsFor(event.getPlayer());
        stats.blocksBroken++;

        Material type = event.getBlock().getType();
        if (!ORES.contains(type)) return;

        stats.oresMined++;
        boolean hidden = isSealed(event.getBlock());
        if (hidden) stats.hiddenOres++;

        boolean valuable = VALUABLE.contains(type);
        if (valuable) {
            stats.valuableOres++;
            if (hidden) stats.hiddenValuableOres++;
        }

        if (stats.oresMined >= MIN_ORES) {
            double ratio = (double) stats.hiddenOres / stats.oresMined;
            if (ratio >= HIDDEN_RATIO_FLAG) {
                stats.addFlag(
                        "xray",
                        String.format(
                                "%d of %d ores were sealed on all sides (%.0f%%)",
                                stats.hiddenOres, stats.oresMined, ratio * 100));
            }
        }
        if (stats.valuableOres >= MIN_VALUABLE) {
            double ratio = (double) stats.hiddenValuableOres / stats.valuableOres;
            if (ratio >= VALUABLE_RATIO_FLAG) {
                stats.addFlag(
                        "xray-valuable",
                        String.format(
                                "%d of %d diamonds/emeralds/debris were sealed (%.0f%%)",
                                stats.hiddenValuableOres, stats.valuableOres, ratio * 100));
            }
        }
    }

    /**
     * Whether the block had no face open to air before it was broken.
     *
     * `isOccluding` rather than `isSolid`: glass, leaves and slabs are solid but
     * see-through, and ore behind them was visible without any client help.
     */
    private boolean isSealed(Block block) {
        for (BlockFace face : FACES) {
            if (!block.getRelative(face).getType().isOccluding()) return false;
        }
        return true;
    }
}
