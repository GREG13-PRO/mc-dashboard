package hu.mcdashboard.guard;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import org.bukkit.entity.Player;

/** The shared store the watchers write into. */
interface Guard {
    PlayerStats statsFor(Player player);

    Map<String, PlayerStats> all();
}

final class GuardStore implements Guard {

    private final Map<String, PlayerStats> byPlayer = new ConcurrentHashMap<>();

    @Override
    public PlayerStats statsFor(Player player) {
        return byPlayer.computeIfAbsent(player.getName(), PlayerStats::new);
    }

    @Override
    public Map<String, PlayerStats> all() {
        return byPlayer;
    }
}
