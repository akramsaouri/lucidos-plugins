#!/usr/bin/env python3
"""A stand-in for the `lucidos` CLI that records each call instead of reaching an engine.

  FAKE_LUCIDOS_LOG   file each call's argv is appended to, one JSON array per line
  FAKE_LUCIDOS_FAIL  a subcommand (`notify`, `events`) that should fail, to test retries
"""
import json
import os
import sys

with open(os.environ["FAKE_LUCIDOS_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\n")
if sys.argv[1:2] == [os.environ.get("FAKE_LUCIDOS_FAIL")]:
    sys.stderr.write("lucidos: engine unreachable\n")
    sys.exit(1)
print('{"success":true}')
