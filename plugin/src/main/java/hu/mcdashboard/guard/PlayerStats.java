package hu.mcdashboard.guard;

import java.util.ArrayDeque;
import java.util.Deque;

/** What the watchers have seen from one player since the server started. */
final class PlayerStats {

    final String name;

    // Mining.
    long blocksBroken;
    long oresMined;
    /**
     * Ores that had no exposed face when they were broken.
     *
     * This is the whole x-ray signal: a player digging normally finds ores by
     * running into them, so most of what they break has been visible from a
     * tunnel. Ore that was sealed on all six sides was not found by looking.
     */
    long hiddenOres;
    long valuableOres;
    long hiddenValuableOres;

    // Movement.
    double maxSpeedPerSecond;
    long fastSeconds;
    /** Horizontal distance accumulated inside the current one-second bucket. */
    double bucketDistance;
    long bucketStartedAtMillis;

    /** Recent flags, newest last; bounded so a long session cannot grow it forever. */
    final Deque<Flag> flags = new ArrayDeque<>();

    PlayerStats(String name) {
        this.name = name;
    }

    void addFlag(String kind, String detail) {
        // One of a kind per player per five minutes: a player who is mining
        // with x-ray keeps mining, and a hundred identical rows help nobody.
        long now = System.currentTimeMillis();
        for (Flag flag : flags) {
            if (flag.kind.equals(kind) && now - flag.atMillis < 5 * 60_000L) return;
        }
        flags.addLast(new Flag(kind, detail, now));
        while (flags.size() > 20) flags.removeFirst();
    }

    record Flag(String kind, String detail, long atMillis) {
    }
}
