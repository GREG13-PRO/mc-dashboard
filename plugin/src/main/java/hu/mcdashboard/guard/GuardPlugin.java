package hu.mcdashboard.guard;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Map;

import org.bukkit.plugin.java.JavaPlugin;

/**
 * Watches for the two things a dashboard cannot see from outside the server,
 * and writes what it saw to a file the dashboard reads.
 *
 * A file rather than a port: the dashboard already has the server's folder
 * open, a second listening socket on a Minecraft host is a thing to secure and
 * explain, and nothing here is time-critical enough to need one.
 *
 * It never punishes. No kick, no ban, no cancelled event - every number it
 * produces is a heuristic, and a heuristic that acts on its own eventually
 * bans someone with bad wifi. It reports; a person decides.
 */
public final class GuardPlugin extends JavaPlugin {

    private static final long WRITE_INTERVAL_TICKS = 20L * 30; // half a minute

    private final GuardStore store = new GuardStore();

    @Override
    public void onEnable() {
        getServer().getPluginManager().registerEvents(new OreWatcher(store), this);
        getServer().getPluginManager().registerEvents(new MovementWatcher(store), this);
        getServer().getScheduler().runTaskTimerAsynchronously(
                this, this::writeReport, WRITE_INTERVAL_TICKS, WRITE_INTERVAL_TICKS);
        getLogger().info("McDashGuard watching; reports go to " + reportPath());
    }

    @Override
    public void onDisable() {
        writeReport();
    }

    private Path reportPath() {
        return getDataFolder().toPath().resolve("report.json");
    }

    /**
     * Writes the report atomically.
     *
     * The dashboard reads this file on its own schedule, and a reader that
     * catches a half-written file sees invalid JSON rather than stale data -
     * so it is written beside and moved into place.
     */
    private void writeReport() {
        try {
            Files.createDirectories(getDataFolder().toPath());
            Path temp = getDataFolder().toPath().resolve("report.json.tmp");
            Files.writeString(temp, render(), StandardCharsets.UTF_8);
            Files.move(temp, reportPath(), StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            getLogger().warning("Could not write the report: " + e.getMessage());
        }
    }

    private String render() {
        StringBuilder out = new StringBuilder();
        out.append("{\"generatedAt\":").append(System.currentTimeMillis());
        out.append(",\"plugin\":\"").append(escape(getPluginMeta().getVersion())).append('"');
        out.append(",\"players\":[");
        boolean first = true;
        for (Map.Entry<String, PlayerStats> entry : store.all().entrySet()) {
            if (!first) out.append(',');
            first = false;
            appendPlayer(out, entry.getValue());
        }
        out.append("]}");
        return out.toString();
    }

    private void appendPlayer(StringBuilder out, PlayerStats stats) {
        out.append("{\"name\":\"").append(escape(stats.name)).append('"');
        out.append(",\"blocksBroken\":").append(stats.blocksBroken);
        out.append(",\"oresMined\":").append(stats.oresMined);
        out.append(",\"hiddenOres\":").append(stats.hiddenOres);
        out.append(",\"valuableOres\":").append(stats.valuableOres);
        out.append(",\"hiddenValuableOres\":").append(stats.hiddenValuableOres);
        out.append(",\"maxSpeed\":").append(String.format(java.util.Locale.ROOT, "%.2f",
                stats.maxSpeedPerSecond));
        out.append(",\"flags\":[");
        boolean first = true;
        for (PlayerStats.Flag flag : stats.flags) {
            if (!first) out.append(',');
            first = false;
            out.append("{\"kind\":\"").append(escape(flag.kind()))
                    .append("\",\"detail\":\"").append(escape(flag.detail()))
                    .append("\",\"at\":").append(flag.atMillis()).append('}');
        }
        out.append("]}");
    }

    /** Minimal JSON string escaping; the plugin writes its own to avoid a dependency. */
    private static String escape(String value) {
        StringBuilder out = new StringBuilder(value.length() + 8);
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        return out.toString();
    }
}
