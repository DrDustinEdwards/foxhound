"""Generate the static DM Sans instances the OG card needs (ruling 96).

Run once, by hand, when app/assets/fonts/dm-sans-variable.woff2 changes:

    python3 scripts/build-og-fonts.py

Why this exists. Satori (workers-og's layout engine) parses fonts with
opentype.js, which cannot read WOFF2's compressed wrapper and cannot parse a
variable font's fvar/gvar/avar/HVAR/STAT tables. Both failures are silent: the
card renders as an empty PNG rather than erroring. That rules out the app's
dm-sans-variable.woff2 FILE. It does not rule out the DM Sans typeface, which
is the correction ruling 96 made to app/routes/files/og.ts, where the card had
been switched wholesale to DM Mono and the switch recorded as a deliberate
design choice without a ratification.

The output is committed, not built in CI: og.ts imports the .ttf files with
Vite's `?inline`, so they are baked into the worker bundle at build time and a
fresh clone must have them. Requires fontTools and brotli, neither of which is
a repo dependency; this is a one-off authoring tool.
"""

import io
import os
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import decompress
from fontTools.varLib import instancer

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS = os.path.join(HERE, os.pardir, "app", "assets", "fonts")
SRC = os.path.join(FONTS, "dm-sans-variable.woff2")
REFERENCE = os.path.join(FONTS, "dm-mono-500.ttf")

# Weights the card actually uses: 400 body/footer, 500 eyebrow, 600 title/pill.
WEIGHTS = (400, 500, 600)

# opentype.js chokes on these. The instancer leaves STAT behind, so strip it
# explicitly rather than assuming the parser tolerates it.
VARIABLE_TABLES = ("fvar", "gvar", "avar", "HVAR", "VVAR", "MVAR", "STAT")


def main() -> None:
    raw = io.BytesIO()
    decompress(SRC, raw)

    raw.seek(0)
    axes = {a.axisTag: (a.minValue, a.defaultValue, a.maxValue) for a in TTFont(raw)["fvar"].axes}
    print("source axes:", axes)

    # dm-mono-500.ttf is the file already proven to parse at request time, so
    # its table set is the bar: the output must add nothing it does not have.
    reference = set(TTFont(REFERENCE).keys())

    for weight in WEIGHTS:
        raw.seek(0)
        static = instancer.instantiateVariableFont(TTFont(raw), {"wght": weight}, inplace=False)
        for table in VARIABLE_TABLES:
            if table in static:
                del static[table]

        dest = os.path.join(FONTS, "dm-sans-%d.ttf" % weight)
        static.save(dest)

        check = TTFont(dest)
        extra = sorted(set(check.keys()) - reference)
        leftover = [t for t in VARIABLE_TABLES if t in check]
        print(
            "wrote %-18s %6d bytes  extra tables vs reference=%s  variable tables=%s"
            % (os.path.basename(dest), os.path.getsize(dest), extra or "none", leftover or "none")
        )
        assert not leftover, "variable table survived instancing: %s" % leftover
        assert not extra, "output carries a table the known good font does not: %s" % extra
        assert "glyf" in check and check["head"].unitsPerEm > 0, "output is not a usable outline font"


if __name__ == "__main__":
    main()
