package hu.mcdashboard.guard;

import org.bukkit.GameMode;
import org.bukkit.Location;
import org.bukkit.Material;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerMoveEvent;
import org.bukkit.potion.PotionEffect;
import org.bukkit.potion.PotionEffectType;

/**
 * The speed signal: horizontal ground speed that nothing legitimate explains.
 *
 * Deliberately blunt and deliberately generous. Sprint-jumping is about 7
 * blocks a second, ice can push past 15, and a laggy client delivers a second
 * of movement in one packet. Anything that tried to catch a subtle speed
 * advantage from here would spend its life accusing people with bad wifi, so
 * the threshold sits far above anything vanilla produces and the plugin
 * reports what it saw rather than deciding what it means.
 *
 * Everything with a legitimate explanation is excluded outright: vehicles,
 * elytra, riptide, flight, speed potions and ice.
 */
final class MovementWatcher implements Listener {

    /** Blocks per second beyond which no vanilla movement on foot goes. */
    private static final double FLAG_SPEED = 22.0;
    /** Consecutive fast seconds before it stops looking like a lag spike. */
    private static final long FLAG_SECONDS = 4;
    /** A single step longer than this is a teleport, not movement. */
    private static final double TELEPORT_STEP = 8.0;

    private final Guard guard;

    MovementWatcher(Guard guard) {
        this.guard = guard;
    }

    @EventHandler(ignoreCancelled = true)
    public void onMove(PlayerMoveEvent event) {
        Location from = event.getFrom();
        Location to = event.getTo();
        if (to == null || from.getWorld() != to.getWorld()) return;

        Player player = event.getPlayer();
        GameMode mode = player.getGameMode();
        if (mode != GameMode.SURVIVAL && mode != GameMode.ADVENTURE) return;
        if (player.isInsideVehicle() || player.isGliding() || player.isFlying()
                || player.isRiptiding() || player.isSwimming()) {
            return;
        }
        if (hasSpeedEffect(player) || onSlipperyGround(player)) return;

        double dx = to.getX() - from.getX();
        double dz = to.getZ() - from.getZ();
        double step = Math.sqrt(dx * dx + dz * dz);
        // A teleport, a portal or a plugin warp arrives as one enormous step;
        // counting it would flag every staff member who uses /tp.
        if (step > TELEPORT_STEP) return;

        PlayerStats stats = guard.statsFor(player);
        long now = System.currentTimeMillis();
        if (stats.bucketStartedAtMillis == 0) stats.bucketStartedAtMillis = now;
        stats.bucketDistance += step;

        long elapsed = now - stats.bucketStartedAtMillis;
        if (elapsed < 1000) return;

        double speed = stats.bucketDistance * 1000.0 / elapsed;
        stats.bucketDistance = 0;
        stats.bucketStartedAtMillis = now;
        if (speed > stats.maxSpeedPerSecond) stats.maxSpeedPerSecond = speed;

        if (speed < FLAG_SPEED) {
            stats.fastSeconds = 0;
            return;
        }
        stats.fastSeconds++;
        if (stats.fastSeconds >= FLAG_SECONDS) {
            stats.addFlag(
                    "speed",
                    String.format(
                            "%.1f blocks/s on foot for %d seconds", speed, stats.fastSeconds));
        }
    }

    private boolean hasSpeedEffect(Player player) {
        PotionEffect effect = player.getPotionEffect(PotionEffectType.SPEED);
        return effect != null;
    }

    /** Ice of any kind makes legitimate speeds that look nothing like walking. */
    private boolean onSlipperyGround(Player player) {
        Material below = player.getLocation().subtract(0, 1, 0).getBlock().getType();
        return below == Material.ICE || below == Material.PACKED_ICE
                || below == Material.BLUE_ICE || below == Material.FROSTED_ICE;
    }
}
