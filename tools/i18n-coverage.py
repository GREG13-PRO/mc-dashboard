#!/usr/bin/env python3
"""Reports how complete each translation is against English.

Every non-English dictionary is Partial<Locale>, so a missing key compiles fine
and shows the English string instead. That is the right runtime behaviour and
the wrong thing to be unaware of, so this is what makes the gaps countable.

Also flags keys a translation has that English does not - always a typo or a
string deleted from English and left behind everywhere else.

Usage:  python3 tools/i18n-coverage.py [--missing <code>]
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALES = os.path.join(ROOT, "frontend/src/locales")

KEY_RE = re.compile(r'^\s{2}("?)([A-Za-z0-9_]+)\1:\s', re.M)


def keys_of(path):
    return [m.group(2) for m in KEY_RE.finditer(io.open(path, encoding="utf-8").read())]


def main():
    english = keys_of(os.path.join(LOCALES, "en.ts"))
    english_set = set(english)
    if len(english) != len(english_set):
        seen, dupes = set(), set()
        for k in english:
            (dupes if k in seen else seen).add(k)
        print(f"en.ts has duplicate keys: {sorted(dupes)}")
        return 1

    wanted = sys.argv[2] if len(sys.argv) > 2 and sys.argv[1] == "--missing" else None
    failures = 0

    for name in sorted(os.listdir(LOCALES)):
        if not name.endswith(".ts") or name == "en.ts":
            continue
        code = name[:-3]
        keys = keys_of(os.path.join(LOCALES, name))
        keys_set = set(keys)

        duplicated = sorted({k for k in keys if keys.count(k) > 1})
        missing = sorted(english_set - keys_set)
        extra = sorted(keys_set - english_set)
        pct = 100.0 * (len(english_set) - len(missing)) / len(english_set)

        flags = []
        if duplicated:
            flags.append(f"{len(duplicated)} duplicate")
        if extra:
            flags.append(f"{len(extra)} unknown")
        note = ("  [" + ", ".join(flags) + "]") if flags else ""
        print(f"{code:<6} {pct:6.1f}%  {len(english_set) - len(missing):>4}/{len(english_set)}"
              f"  missing {len(missing)}{note}")

        if duplicated or extra:
            failures += 1
            if duplicated:
                print(f"       duplicate: {duplicated[:10]}")
            if extra:
                print(f"       not in en: {extra[:10]}")
        if wanted == code and missing:
            print("       missing keys:")
            for key in missing:
                print(f"         {key}")

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
