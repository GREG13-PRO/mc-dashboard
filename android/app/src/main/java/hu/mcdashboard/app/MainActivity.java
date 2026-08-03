package hu.mcdashboard.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The app is a shell around the dashboard that already runs on the Minecraft
 * host: it asks where that host is, then shows it.
 *
 * It deliberately does not bundle the server, for the same reason the desktop
 * app does not - the backend has to run next to the Minecraft servers it
 * manages (screen, ps, the world folders), which is not the phone.
 */
public class MainActivity extends Activity {

    private static final int FILE_CHOOSER_REQUEST = 1;

    private WebView web;
    private View errorView;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        String url = Prefs.serverUrl(this);
        if (url == null) {
            startActivity(new Intent(this, SetupActivity.class));
            finish();
            return;
        }

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        web = new WebView(this);
        configureWebView();
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        errorView = buildErrorView();
        errorView.setVisibility(View.GONE);
        root.addView(errorView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(root);
        web.loadUrl(url);

        new UpdateChecker(this).checkInBackground();
    }

    private void configureWebView() {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        // The dashboard keeps the theme, language and display preferences in
        // localStorage, so without this every launch would come back English
        // and light.
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        // Honour the page's own viewport meta rather than pretending to be a
        // desktop-width screen; the layout below 760px is the point of this.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // Uploading plugins, schematics and resource packs all go
                // through the page's <input type="file">, which does nothing
                // in a WebView unless the app opens the picker itself.
                if (pendingFileCallback != null) {
                    pendingFileCallback.onReceiveValue(null);
                }
                pendingFileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    pendingFileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                String base = Prefs.serverUrl(MainActivity.this);
                // Links to plugin pages and the LuckPerms editor point at other
                // sites; those belong in the browser, not inside the shell.
                if (base != null && target.startsWith(base)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, R.string.cannot_open_link,
                            Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                errorView.setVisibility(View.GONE);
                web.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request,
                                        WebResourceError error) {
                // Only a failed main document means the dashboard is
                // unreachable; a single failed map tile or icon must not
                // replace a working page with an error screen.
                if (request.isForMainFrame()) {
                    showError();
                }
            }
        });

        web.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String disposition,
                                        String mimeType, long size) {
                try {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
                    // Backups are behind the session, so the download needs the
                    // WebView's cookie or it fetches the login page instead.
                    request.addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url));
                    request.addRequestHeader("User-Agent", userAgent);
                    String name = URLUtil.guessFileName(url, disposition, mimeType);
                    request.setTitle(name);
                    request.setNotificationVisibility(
                            DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
                    DownloadManager manager =
                            (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                    manager.enqueue(request);
                    Toast.makeText(MainActivity.this, R.string.download_started,
                            Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, R.string.download_failed,
                            Toast.LENGTH_LONG).show();
                }
            }
        });
    }

    private View buildErrorView() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#12151a"));
        int pad = (int) (24 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, pad);

        TextView message = new TextView(this);
        message.setText(R.string.cannot_reach_server);
        message.setTextColor(Color.parseColor("#f5f5f7"));
        message.setGravity(Gravity.CENTER);
        box.addView(message);

        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            web.reload();
        });
        box.addView(retry);

        Button change = new Button(this);
        change.setText(R.string.change_server);
        change.setOnClickListener(v -> openSetup());
        box.addView(change);

        return box;
    }

    private void showError() {
        // Hiding the WebView too: a half-loaded page behind the error box looks
        // like the app is working when it is not.
        web.setVisibility(View.INVISIBLE);
        errorView.setVisibility(View.VISIBLE);
    }

    private void openSetup() {
        startActivity(new Intent(this, SetupActivity.class));
        finish();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode != FILE_CHOOSER_REQUEST) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        if (pendingFileCallback == null) return;
        // A cancelled picker still has to answer the callback, or the page's
        // file input stays permanently unresponsive.
        pendingFileCallback.onReceiveValue(
                resultCode == RESULT_OK
                        ? WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                        : null);
        pendingFileCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
            return;
        }
        // At the root there is nowhere to go back to, so back becomes the app's
        // only menu - which is also where the server can be changed without
        // waiting for it to become unreachable.
        new AlertDialog.Builder(this)
                .setTitle(R.string.app_name)
                .setItems(
                        new CharSequence[]{
                                getString(R.string.change_server), getString(R.string.quit)
                        },
                        (dialog, which) -> {
                            if (which == 0) {
                                openSetup();
                            } else {
                                finish();
                            }
                        })
                .setNegativeButton(android.R.string.cancel, null)
                .show();
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Flushed here rather than on destroy: the session cookie has to
        // survive the app being killed in the background.
        CookieManager.getInstance().flush();
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
