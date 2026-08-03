package hu.mcdashboard.app;

import android.content.Context;
import android.content.SharedPreferences;

/** Where the dashboard lives, as entered on the setup screen. */
final class Settings {

    private static final String PREFS = "mc-dashboard";
    private static final String KEY_URL = "serverUrl";

    private Settings() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static String serverUrl(Context context) {
        return prefs(context).getString(KEY_URL, null);
    }

    static void setServerUrl(Context context, String url) {
        prefs(context).edit().putString(KEY_URL, url).apply();
    }
}
