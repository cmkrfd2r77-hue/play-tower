"""Build data/compat.json from the Play! compatibility tracker on GitHub.

Each issue in jpd002/Play-Compatibility is titled "[SERIAL] Game name" and
carries a "state-*" label (state-playable, state-ingame, ...). The output maps
serial -> state so the library can show how well each game runs.

Usage: GITHUB_TOKEN=... python3 tools/build_compat.py [out.json]
"""
import json
import os
import re
import sys
import urllib.request

REPO = "jpd002/Play-Compatibility"
serial_re = re.compile(r"\[([A-Z]{4})[-_ ]?(\d{3})\.?(\d{2})\]")


def fetch(page, token):
    url = f"https://api.github.com/repos/{REPO}/issues?state=all&per_page=100&page={page}"
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "ps2-compat-builder"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "data/compat.json"
    token = os.environ.get("GITHUB_TOKEN", "")
    states = {}
    page = 1
    while True:
        issues = fetch(page, token)
        if not issues:
            break
        for issue in issues:
            if "pull_request" in issue:
                continue
            m = serial_re.search(issue.get("title", ""))
            if not m:
                continue
            serial = f"{m.group(1)}-{m.group(2)}{m.group(3)}"
            labels = [l["name"] for l in issue.get("labels", [])]
            state = next((l[len("state-"):] for l in labels if l.startswith("state-")), None)
            if state:
                states[serial] = {"state": state, "issue": issue["number"]}
        page += 1
        if page > 100:
            break
    if len(states) < 100:
        raise SystemExit(f"Only {len(states)} entries found; refusing to overwrite {out}")
    data = {"source": f"https://github.com/{REPO}", "count": len(states), "games": dict(sorted(states.items()))}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(states)} entries to {out}")


if __name__ == "__main__":
    main()
