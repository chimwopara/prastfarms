#!/bin/sh
# Stamps the current commit into portal.html and version.json, so a page left
# open can tell when the server has something newer. Run before deploying.
set -e
cd "$(dirname "$0")/.."
SHA=$(git rev-parse --short HEAD)
python3 - "$SHA" <<'PY'
import re, sys, pathlib, json
sha = sys.argv[1]
p = pathlib.Path('portal.html')
s = p.read_text(encoding='utf-8')
p.write_text(re.sub(r"const APP_VERSION = '[^']*'",
                    f"const APP_VERSION = '{sha}'", s, count=1), encoding='utf-8')
pathlib.Path('version.json').write_text(json.dumps({"build": sha}) + "\n", encoding='utf-8')
print(f"  stamped {sha}")
PY
