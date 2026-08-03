#!/usr/bin/env python3
"""Drives the installed app on an emulator and checks what it actually shows.

Lives in a file rather than in the workflow because the emulator action runs
each line of its `script` through its own shell, so anything spanning more than
one line - a function, a loop - is a syntax error at the second line.
"""

import re
import subprocess
import sys
import time

PACKAGE = "hu.mcdashboard.app"
# The emulator's alias for the runner's own loopback.
HOST = "10.0.2.2"


def adb(*args, capture=False):
    if capture:
        return subprocess.run(["adb", *args], check=True, capture_output=True).stdout
    subprocess.run(["adb", *args], check=True)
    return b""


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


def tap(description, dump_name):
    xml = hierarchy(dump_name)
    node = re.search(r"<node[^>]*/>", xml)
    match = None
    for node in re.finditer(r"<node[^>]*?/?>", xml):
        text = node.group(0)
        if f'content-desc="{description}"' in text:
            match = re.search(BOUNDS, text)
            if match:
                break
    if not match:
        print(xml[:4000])
        raise SystemExit(f"no view with content-desc={description}")
    x1, y1, x2, y2 = map(int, match.groups())
    adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
    print(f"tapped {description} at {(x1 + x2) // 2},{(y1 + y2) // 2}")


def main():
    adb("install", "-r", "android/app/build/outputs/apk/debug/app-debug.apk")
    adb("shell", "am", "start", "-n", f"{PACKAGE}/.MainActivity")
    time.sleep(6)
    screenshot("1-setup.png")

    tap("host", "ui-setup.xml")
    adb("shell", "input", "text", HOST)
    tap("connect", "ui-filled.xml")
    time.sleep(10)
    screenshot("2-loaded.png")

    after = hierarchy("ui-loaded.xml")
    failures = []
    # The page's own text in the view hierarchy is the proof it rendered; a
    # screenshot alone can look plausible while showing nothing.
    if "WEBVIEW OK" not in after:
        failures.append("the page did not render in the WebView")
    if "localStorage: stored" not in after:
        failures.append("localStorage did not work")

    if failures:
        print(after[:4000])
        for line in failures:
            print(f"FAIL: {line}")
        sys.exit(1)

    print("PASS: page rendered in the WebView")
    print("PASS: JavaScript and localStorage work")


if __name__ == "__main__":
    main()
