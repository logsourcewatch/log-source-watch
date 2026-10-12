#!/usr/bin/env python3
from pathlib import Path
import configparser
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app" / "logsource_watch"

errors = []
passes = []

def ok(msg): passes.append(msg)
def fail(msg): errors.append(msg)

required = [
    APP/"default/app.conf",
    APP/"default/collections.conf",
    APP/"default/transforms.conf",
    APP/"default/savedsearches.conf",
    APP/"default/data/ui/nav/default.xml",
    APP/"LICENSE.txt",
]
for p in required:
    if p.exists():
        ok(f"required: {p.relative_to(ROOT)}")
    else:
        fail(f"missing required file: {p.relative_to(ROOT)}")

# XML
for p in (APP/"default/data/ui").rglob("*.xml"):
    try:
        ET.parse(p)
    except Exception as e:
        fail(f"XML {p.relative_to(ROOT)}: {e}")
else:
    ok("XML parsing")

# Python syntax without generating pyc.
for p in (APP/"bin").glob("*.py"):
    try:
        compile(p.read_text(encoding="utf-8"), str(p), "exec")
    except Exception as e:
        fail(f"Python {p.relative_to(ROOT)}: {e}")
else:
    ok("Python syntax")

# JavaScript syntax when Node is available.
node = subprocess.run(["node", "--version"], capture_output=True, text=True)
if node.returncode == 0:
    for p in (APP/"appserver/static").glob("*.js"):
        r = subprocess.run(["node", "--check", str(p)], capture_output=True, text=True)
        if r.returncode:
            fail(f"JavaScript {p.relative_to(ROOT)}: {r.stderr.strip()}")
    ok("JavaScript syntax")
else:
    print("WARN: node not available; JS syntax check skipped")

# Public-repository secret guard.
for p in ROOT.rglob("*"):
    if not p.is_file() or ".git" in p.parts:
        continue
    name = p.name.lower()
    if name == "issuer_key.json":
        fail(f"private issuer key present: {p.relative_to(ROOT)}")
    if name == "lsw_license.json" or name.endswith(".lsw-license.json"):
        fail(f"customer/license file present: {p.relative_to(ROOT)}")
ok("private-license material guard")

# Do not ship local/.
if (APP/"local").exists():
    fail("app/logsource_watch/local must not be committed")
else:
    ok("no app local/ directory")

# Canonical states.
combined = ""
for p in APP.rglob("*"):
    if not p.is_file():
        continue
    try:
        combined += "\n" + p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        pass
for state in ("OK","SILENT","NO LOG OBSERVATION","MAINTENANCE","RETIRED"):
    if state not in combined:
        fail(f"canonical state not found: {state}")
ok("canonical state model")

# Known legacy Finnish internal state strings should not return.
for forbidden in ("HILJAINEN","HUOLLOSSA","EI LOKIHAVAINTOA"):
    if forbidden in combined:
        fail(f"legacy internal state present: {forbidden}")
ok("no legacy Finnish canonical states")

print("\nLog Source Watch repository validation")
print("="*42)
for p in passes:
    print("PASS", p)
for e in errors:
    print("FAIL", e)

if errors:
    print(f"\nFAILED: {len(errors)} issue(s)")
    sys.exit(1)
print(f"\nPASS: {len(passes)} checks")
