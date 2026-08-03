#!/usr/bin/env python3
"""Drives the installed app on an emulator and checks what it actually shows.

Lives in a file rather than in the workflow because the emulator action runs
each line of its `script` through its own shell, so anything spanning more than
one line - a function, a loop - is a syntax error at the second line.

It also serves the stand-in page itself instead of leaving that to an earlier
workflow step, so the server is guaranteed to be alive for exactly as long as
the test needs it.
"""

import http.server
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

PACKAGE = "hu.mcdashboard.app"
# The emulator's alias for the runner's own loopback.
HOST = "10.0.2.2"
PORT = 3000

PAGE = """<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="background:#12151a;color:#f5f5f7;font:16px sans-serif;padding:24px">
<h1>WEBVIEW OK</h1>
<p id="stored"></p>
<script>
  // The same two things the dashboard needs from a WebView.
  localStorage.setItem("smoke", "stored");
  document.getElementById("stored").textContent =
    "localStorage: " + localStorage.getItem("smoke");
</script>
</body>
"""


def serve():
    directory = tempfile.mkdtemp()
    with open(os.path.join(directory, "index.html"), "w", encoding="utf-8") as handle:
        handle.write(PAGE)

    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=directory, **kw
    )
    server = http.server.ThreadingHTTPServer(("0.0.0.0", PORT), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=5) as response:
        assert response.status == 200
    print(f"stand-in page served on {PORT}")
    return server


def adb(*args, capture=False, check=True):
    result = subprocess.run(["adb", *args], capture_output=True, check=check)
    return result.stdout if capture else b""


def screenshot(name):
    png = adb("exec-out", "screencap", "-p", capture=True)
    with open(name, "wb") as handle:
        handle.write(png)
    print(f"captured {name} ({len(png)} bytes)")


def hierarchy(name):
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml")
    adb("pull", "/sdcard/ui.xml", name)
    with open(name, encoding="utf-8", errors="replace") as handle:
        return handle.read()


BOUNDS = r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'


def find(xml, attribute, value):
    for node in re.finditer(r"<node[^>]*?/?>", xml):
        text = node.group(0)
        if f'{attribute}="{value}"' in text:
            match = re.search(BOUNDS, text)
            if match:
                return tuple(map(int, match.groups()))
    return None


def tap_bounds(bounds, label):
    x1, y1, x2, y2 = bounds
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    print(f"tapped {label} at {(x1 + x2) // 2},{(y1 + y2) // 2}")


def dismiss_system_dialog(dump_name):
    """Clears the keyboard's runtime permission prompt.

    Focusing a text field raises the AOSP keyboard, which on a fresh emulator
    immediately asks for contacts access - and that dialog swallows the next
    tap, which is how this test first "failed" with the app working fine.
    """
    xml = hierarchy(dump_name)
    for label in ("DENY", "Deny", "DENY ANYWAY"):
        bounds = find(xml, "text", label)
        if bounds:
            tap_bounds(bounds, f"permission dialog {label}")
            time.sleep(1.5)
            return True
    return False


def tap(description, dump_name):
    for attempt in range(3):
        xml = hierarchy(dump_name)
        bounds = find(xml, "content-desc", description)
        if bounds:
            tap_bounds(bounds, description)
            return
        if not dismiss_system_dialog(f"{dump_name}.dialog{attempt}.xml"):
            break
    print(hierarchy(dump_name)[:4000])
    raise SystemExit(f"no view with content-desc={description}")


def disable_keyboards():
    """Turns off every input method for the run.

    Focusing a text field otherwise raises the AOSP keyboard, which on a fresh
    emulator immediately asks for contacts access - and that dialog sits over
    the button the test needs to press next. `input text` injects key events
    directly and does not need an IME at all, so the simplest fix is to have no
    keyboard on screen.
    """
    listing = adb("shell", "ime", "list", "-s", capture=True).decode("utf-8", "replace")
    for ime in listing.split():
        if "/" in ime:
            adb("shell", "ime", "disable", ime, check=False)
            print(f"disabled ime {ime}")


def wait_for(text, timeout=30):
    """Polls the view hierarchy instead of sleeping a guessed number of seconds."""
    deadline = time.time() + timeout
    xml = ""
    while time.time() < deadline:
        xml = hierarchy("ui-loaded.xml")
        if text in xml:
            return xml
        time.sleep(2)
    return xml


def main():
    server = serve()
    adb("install", "-r", "android/app/build/outputs/apk/debug/app-debug.apk")
    disable_keyboards()
    adb("shell", "am", "start", "-n", f"{PACKAGE}/.MainActivity")
    time.sleep(6)
    screenshot("1-setup.png")

    setup = hierarchy("ui-setup.xml")
    for field in ("host", "port", "connect"):
        if f'content-desc="{field}"' not in setup:
            print(setup[:4000])
            raise SystemExit(f"the setup screen has no {field} field")
    print("PASS: the setup screen rendered with all its fields")

    tap("host", "ui-setup.xml")
    adb("shell", "input", "text", HOST)
    screenshot("2-filled.png")
    tap("connect", "ui-filled.xml")

    after = wait_for("WEBVIEW OK")
    screenshot("3-loaded.png")
    failures = []
    # The page's own text in the view hierarchy is the proof it rendered; a
    # screenshot alone can look plausible while showing nothing.
    if "WEBVIEW OK" not in after:
        failures.append("the page did not render in the WebView")
    if "localStorage: stored" not in after:
        failures.append("localStorage did not work")

    server.shutdown()

    if failures:
        print(after[:4000])
        print("--- app logcat ---")
        print(adb("logcat", "-d", "-t", "200", capture=True).decode("utf-8", "replace")[-4000:])
        for line in failures:
            print(f"FAIL: {line}")
        sys.exit(1)

    print("PASS: page rendered in the WebView")
    print("PASS: JavaScript and localStorage work")


if __name__ == "__main__":
    main()
