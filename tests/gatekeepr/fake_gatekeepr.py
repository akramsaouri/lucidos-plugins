#!/usr/bin/env python3
"""A stand-in for the gatekeepr CLI that prints a synthetic fixture instead of reading /var/log/appgate.

  FAKE_GATEKEEPR_STATUS   file printed verbatim for `gatekeepr --json`
  FAKE_GATEKEEPR_HISTORY  file printed verbatim for `gatekeepr history --json`
  FAKE_GATEKEEPR_EXIT     exit code to use instead of the fixture's exitCode; 64 prints usage on stderr only
  FAKE_GATEKEEPR_SLEEP    seconds to sleep first, to test the reader's timeout
  FAKE_GATEKEEPR_LOG      file each invocation's arguments are appended to, one line per call
"""
import json
import os
import sys
import time

args = sys.argv[1:]
if os.environ.get("FAKE_GATEKEEPR_LOG"):
    with open(os.environ["FAKE_GATEKEEPR_LOG"], "a") as f:
        f.write(" ".join(args) + "\n")
if os.environ.get("FAKE_GATEKEEPR_SLEEP"):
    time.sleep(float(os.environ["FAKE_GATEKEEPR_SLEEP"]))
if os.environ.get("FAKE_GATEKEEPR_EXIT") == "64":
    sys.stderr.write("Error: unknown option.\nUsage: gatekeepr status [--json]\n")
    sys.exit(64)

source = os.environ.get("FAKE_GATEKEEPR_HISTORY" if args[:1] == ["history"] else "FAKE_GATEKEEPR_STATUS")
with open(source) as f:
    text = f.read()
sys.stdout.write(text)
try:
    code = json.loads(text).get("exitCode", 0)
except ValueError:
    code = 0
sys.exit(int(os.environ.get("FAKE_GATEKEEPR_EXIT") or code))
