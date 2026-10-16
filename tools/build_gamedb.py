"""Build data/gamedb.json from PCSX2's GameIndex.yaml.

The output maps each disc serial to [title, region] and lets the frontend name
games and pick their covers from the serial found on the disc.

Usage: python3 tools/build_gamedb.py [GameIndex.yaml] [out.json]
Without a path, the latest GameIndex.yaml is downloaded from GitHub.
"""
import json
import re
import sys
import urllib.request

SOURCE_URL = "https://raw.githubusercontent.com/PCSX2/pcsx2/master/bin/resources/GameIndex.yaml"
REGIONS = {"NTSC-U": "U", "NTSC-J": "J", "PAL": "E", "NTSC-K": "K", "NTSC-C": "C", "NTSC-T": "T"}

entry_re = re.compile(r"^([A-Z0-9][A-Z0-9_-]*):\s*$")
field_re = re.compile(r"^  (name|name-en|region):\s*(.+?)\s*$")


def unquote(value):
    """Return a YAML scalar's text, dropping a trailing "# comment" outside the quotes."""
    if value.startswith('"'):
        m = re.match(r'"((?:[^"\\]|\\.)*)"', value)
        if m:
            try:
                return json.loads('"' + m.group(1) + '"')
            except ValueError:
                return m.group(1)
        return value.strip('"')
    if value.startswith("'"):
        m = re.match(r"'((?:[^']|'')*)'", value)
        return (m.group(1) if m else value.strip("'")).replace("''", "'")
    return re.split(r"\s+#", value, maxsplit=1)[0]


def parse(lines):
    games = {}
    serial = None
    fields = {}

    def flush():
        if serial and ("name" in fields or "name-en" in fields):
            title = fields.get("name-en") or fields.get("name")
            region = fields.get("region", "")
            code = next((v for k, v in REGIONS.items() if region == k or region.startswith(k + "-")), "")
            games[serial] = [title, code]

    for line in lines:
        m = entry_re.match(line)
        if m:
            flush()
            serial, fields = m.group(1), {}
            continue
        if serial:
            f = field_re.match(line)
            if f:
                fields[f.group(1)] = unquote(f.group(2))
    flush()
    return games


def main():
    out = sys.argv[2] if len(sys.argv) > 2 else "data/gamedb.json"
    if len(sys.argv) > 1 and sys.argv[1] != "-":
        with open(sys.argv[1], encoding="utf-8") as f:
            text = f.read()
    else:
        with urllib.request.urlopen(SOURCE_URL, timeout=60) as r:
            text = r.read().decode("utf-8")
    games = parse(text.splitlines())
    if len(games) < 1000:
        raise SystemExit(f"Only {len(games)} games parsed; refusing to overwrite {out}")
    data = {"source": SOURCE_URL, "count": len(games), "games": dict(sorted(games.items()))}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(games)} games to {out}")


if __name__ == "__main__":
    main()
