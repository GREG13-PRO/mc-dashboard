package hu.mcdashboard.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Asks the dashboard whether a newer build of this app is published.
 *
 * The dashboard rather than GitHub: this project's repository is private, so an
 * unauthenticated request for its latest release gets a 404, and a token
 * shipped inside the app is a token everyone holding the app has. The
 * dashboard is the one server this app is already pointed at.
 *
 * Nothing installs by itself. The download only starts once the update has been
 * offered and accepted, and Android puts its own confirmation in front of the
 * install on top of that.
 */
final class UpdateChecker {

    private final Activity activity;

    UpdateChecker(Activity activity) {
        this.activity = activity;
    }

    void checkInBackground() {
        new Thread(() -> {
            try {
                check();
            } catch (Exception e) {
                // A failed update check must never be the reason the dashboard
                // does not come up; the app works exactly as well without it.
            }
        }).start();
    }

    private void check() throws Exception {
        String base = Prefs.serverUrl(activity);
        if (base == null) return;

        JSONObject build = new JSONObject(get(base + "/api/app/android"));
        String latest = build.getString("version");
        String installed = BuildConfig.VERSION_NAME;
        if (compare(latest, installed) <= 0) return;

        new Handler(Looper.getMainLooper()).post(() -> offer(latest, base, build));
    }

    private void offer(String latest, String base, JSONObject build) {
        if (activity.isFinishing()) return;
        new AlertDialog.Builder(activity)
                .setTitle(activity.getString(R.string.update_title))
                .setMessage(activity.getString(R.string.update_message, latest,
                        BuildConfig.VERSION_NAME))
                .setPositiveButton(R.string.update_now,
                        (d, w) -> download(base, build.optString("filename", "mc-dashboard.apk")))
                .setNegativeButton(R.string.update_later, null)
                .show();
    }

    private void download(String base, String filename) {
        // Android 8 and up refuse an install from an app without this, and the
        // dialog is per-app rather than a permission prompt, so it has to be
        // sent to Settings rather than requested.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            new AlertDialog.Builder(activity)
                    .setMessage(R.string.update_needs_permission)
                    .setPositiveButton(android.R.string.ok, (d, w) -> activity.startActivity(
                            new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                    Uri.parse("package:" + activity.getPackageName()))))
                    .setNegativeButton(android.R.string.cancel, null)
                    .show();
            return;
        }

        DownloadManager.Request request =
                new DownloadManager.Request(Uri.parse(base + "/api/app/android/download"));
        request.setTitle(filename);
        request.setMimeType("application/vnd.android.package-archive");
        request.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        // The app's own external files directory needs no storage permission
        // and is readable by the package installer through a content URI.
        request.setDestinationInExternalFilesDir(activity, null, filename);

        DownloadManager manager =
                (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
        long id = manager.enqueue(request);
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show();
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        InstallOnComplete receiver = new InstallOnComplete(id);
        // The flags overload only exists from API 33, and calling it below that
        // is a NoSuchMethodError rather than a compile error.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            activity.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED);
        } else {
            activity.registerReceiver(receiver, filter);
        }
    }

    private final class InstallOnComplete extends BroadcastReceiver {
        private final long id;

        InstallOnComplete(long id) {
            this.id = id;
        }

        @Override
        public void onReceive(Context context, Intent intent) {
            if (intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1) != id) return;
            try {
                context.unregisterReceiver(this);
            } catch (Exception ignored) {
                // Already gone; nothing to undo.
            }

            DownloadManager manager =
                    (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            Uri file = manager.getUriForDownloadedFile(id);
            if (file == null) {
                Toast.makeText(context, R.string.update_failed, Toast.LENGTH_LONG).show();
                return;
            }
            try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                    if (column >= 0 && cursor.getInt(column) != DownloadManager.STATUS_SUCCESSFUL) {
                        Toast.makeText(context, R.string.update_failed, Toast.LENGTH_LONG).show();
                        return;
                    }
                }
            }

            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(file, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
        }
    }

    private static String get(String url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(6000);
        connection.setReadTimeout(6000);
        try {
            if (connection.getResponseCode() != 200) {
                throw new IllegalStateException("HTTP " + connection.getResponseCode());
            }
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                }
                return out.toString("UTF-8");
            }
        } finally {
            connection.disconnect();
        }
    }

    /** Positive when the first version is newer. */
    static int compare(String a, String b) {
        String[] left = a.split("\\.");
        String[] right = b.split("\\.");
        for (int i = 0; i < Math.max(left.length, right.length); i++) {
            int l = i < left.length ? parse(left[i]) : 0;
            int r = i < right.length ? parse(right[i]) : 0;
            if (l != r) return l - r;
        }
        return 0;
    }

    private static int parse(String part) {
        try {
            return Integer.parseInt(part.replaceAll("[^0-9]", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
