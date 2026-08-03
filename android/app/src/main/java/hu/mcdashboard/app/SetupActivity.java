package hu.mcdashboard.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Asks for the host and port of the dashboard, the same two questions the
 * desktop app asks on first run.
 *
 * Host and port rather than a full URL: everyone running this knows their
 * server's address and the port it was set up on, and a free-text URL field
 * invites typos that produce a blank screen with no explanation.
 */
public class SetupActivity extends Activity {

    private static final String DEFAULT_PORT = "3000";

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_VERTICAL);
        float density = getResources().getDisplayMetrics().density;
        int pad = (int) (24 * density);
        box.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText(R.string.setup_title);
        title.setTextSize(20);
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText(R.string.setup_hint);
        hint.setTextColor(Color.GRAY);
        hint.setPadding(0, (int) (4 * density), 0, (int) (16 * density));
        box.addView(hint);

        EditText host = new EditText(this);
        host.setHint(R.string.host_hint);
        // These views are built in code, so they have no resource ids for a
        // screen reader - or for the emulator smoke test - to hold on to.
        host.setContentDescription("host");
        host.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        host.setSingleLine(true);
        box.addView(host);

        EditText port = new EditText(this);
        port.setHint(R.string.port_hint);
        port.setContentDescription("port");
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        port.setSingleLine(true);
        port.setText(DEFAULT_PORT);
        box.addView(port);

        // Prefilled when changing servers, so a port-only correction does not
        // mean retyping the address.
        String existing = Settings.serverUrl(this);
        if (existing != null) {
            String stripped = existing.replaceFirst("^https?://", "");
            int colon = stripped.lastIndexOf(':');
            if (colon > 0) {
                host.setText(stripped.substring(0, colon));
                port.setText(stripped.substring(colon + 1));
            } else {
                host.setText(stripped);
            }
        }

        Button connect = new Button(this);
        connect.setText(R.string.connect);
        connect.setContentDescription("connect");
        connect.setOnClickListener(v -> {
            String h = host.getText().toString().trim().replaceFirst("^https?://", "");
            String p = port.getText().toString().trim();
            if (h.isEmpty()) {
                Toast.makeText(this, R.string.host_required, Toast.LENGTH_SHORT).show();
                return;
            }
            if (p.isEmpty()) p = DEFAULT_PORT;
            // A trailing slash here becomes a double slash in every request the
            // page makes, which some of the API routes do not match.
            while (h.endsWith("/")) h = h.substring(0, h.length() - 1);
            Settings.setServerUrl(this, "http://" + h + ":" + p);
            startActivity(new Intent(this, MainActivity.class));
            finish();
        });
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        buttonParams.topMargin = (int) (16 * density);
        box.addView(connect, buttonParams);

        setContentView(box);
    }
}
