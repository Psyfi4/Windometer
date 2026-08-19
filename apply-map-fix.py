#!/usr/bin/env python3
"""
Wire components/StationMap.jsx into app/page.jsx.

Run from the repository root:

    python3 apply-map-fix.py

Three edits, each checked before it is made: every block below must appear
exactly once in the file. If any of them appears zero times or more than once
the script changes nothing and says which — better a refusal than a file half
edited against source that has moved on.

A backup is written to app/page.jsx.bak.
"""

import sys
from pathlib import Path

PAGE = Path("app/page.jsx")

EDITS = [
    (
        "add the import",
        "import Backdrop from '@/components/Backdrop';",
        "import Backdrop from '@/components/Backdrop';\n"
        "import StationMap from '@/components/StationMap';",
    ),
    (
        "drop the bbox and src the component now builds itself",
        "function RegionTab({ site, lat, lon }) {\n"
        "  const meta = site !== 'auto' ? SITES.SITES[site] : null;\n"
        "  const d = 1.4;\n"
        "  const bbox = `${(lon - d).toFixed(4)},${(lat - d * 0.7).toFixed(4)},"
        "${(lon + d).toFixed(4)},${(lat + d * 0.7).toFixed(4)}`;\n"
        "  const src = `https://www.openstreetmap.org/export/embed.html"
        "?bbox=${bbox}&layer=mapnik&marker=${lat},${lon}`;\n",
        "function RegionTab({ site, lat, lon }) {\n"
        "  const meta = site !== 'auto' ? SITES.SITES[site] : null;\n",
    ),
    (
        "swap the raw iframe for the component",
        '      <div className="mapframe" style={{ marginTop: \'1rem\' }}>\n'
        '        <iframe title="Station location" src={src} loading="lazy" />\n'
        "      </div>\n",
        "      <div style={{ marginTop: '1rem' }}>\n"
        "        <StationMap lat={lat} lon={lon} />\n"
        "      </div>\n",
    ),
]


def main() -> int:
    if not PAGE.exists():
        print(f"  {PAGE} not found. Run this from the repository root.")
        return 1
    if not Path("components/StationMap.jsx").exists():
        print("  components/StationMap.jsx not found. Add it before running this.")
        return 1

    src = PAGE.read_text()

    problems = []
    for label, old, _new in EDITS:
        n = src.count(old)
        status = "ok" if n == 1 else f"found {n} times"
        print(f"  {'ok  ' if n == 1 else 'FAIL'} {label}  ({status})")
        if n != 1:
            problems.append(label)

    if problems:
        print()
        print("  Nothing changed. The file does not match what this patch expects,")
        print("  which usually means it has been edited since. Make the three edits")
        print("  by hand from the README, or send the file over.")
        return 1

    PAGE.with_suffix(".jsx.bak").write_text(src)
    for _label, old, new in EDITS:
        src = src.replace(old, new, 1)
    PAGE.write_text(src)

    print()
    print(f"  Patched {PAGE}. Previous version at {PAGE}.bak")

    # the things most likely to be wrong after an automated edit
    leftovers = [n for n in ("bbox", "loading=\"lazy\"") if n in src.split("function RegionTab")[1].split("function CompareTab")[0]]
    print(f"  {'FAIL' if leftovers else 'ok  '} no leftovers in RegionTab"
          + (f": {', '.join(leftovers)}" if leftovers else ""))
    print(f"  {'ok  ' if 'StationMap' in src else 'FAIL'} StationMap imported and used")
    opens = src.count("<div ") + src.count("<div>")
    closes = src.count("</div>")
    selfclose = src.count("/>")
    print(f"  {'ok  ' if opens - closes >= 0 else 'FAIL'} div balance plausible "
          f"({opens} open, {closes} close, {selfclose} self-closing)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
