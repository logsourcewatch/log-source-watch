#!/usr/bin/env python3
from pathlib import Path
import argparse
import hashlib
import shutil
import tarfile

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app" / "logsource_watch"
DIST = ROOT / "dist"

parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True)
args = parser.parse_args()

DIST.mkdir(exist_ok=True)
out = DIST / f"logsource_watch-{args.version}.tgz"

def filt(info):
    info.uid = 0
    info.gid = 0
    info.uname = "root"
    info.gname = "root"
    info.mode = 0o755 if info.isdir() else 0o644
    return info

with tarfile.open(out, "w:gz", format=tarfile.PAX_FORMAT) as tf:
    tf.add(APP, arcname="logsource_watch", recursive=True, filter=filt)

sha = hashlib.sha256(out.read_bytes()).hexdigest()
sha_file = Path(str(out) + ".sha256")
sha_file.write_text(f"{sha}  {out.name}\n", encoding="ascii")

# Release shape check.
with tarfile.open(out, "r:gz") as tf:
    names = tf.getnames()
    if not names or not all(n == "logsource_watch" or n.startswith("logsource_watch/") for n in names):
        raise SystemExit("Invalid release archive: expected one top-level logsource_watch/ directory")
    if any("__pycache__" in n or n.endswith(".pyc") for n in names):
        raise SystemExit("Invalid release archive: Python bytecode included")
    if any("/local/" in f"/{n}/" for n in names):
        raise SystemExit("Invalid release archive: local/ included")

print(out)
print(sha_file)
print("SHA256", sha)
