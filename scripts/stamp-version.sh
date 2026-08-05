#!/bin/sh
# Stamps the current commit into portal.html so a running copy can tell when the
# server has something newer. Run this, then commit, before every push.
set -e
cd "$(dirname "$0")/.."
SHA=$(git rev-parse --short HEAD)
python3 - "$SHA" <<'PY'
import re, sys, pathlib
sha = sys.argv[1]
p = pathlib.Path('portal.html')
s = p.read_text(encoding='utf-8')
new = re.sub(r"const APP_VERSION = '[^']*'", f"const APP_VERSION = '{sha}'", s, count=1)
p.write_text(new, encoding='utf-8')
print(f"  stamped APP_VERSION = {sha}")
PY
