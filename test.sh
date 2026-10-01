#!/bin/sh
# Runs engine tests with macOS's built-in JavaScriptCore (no Node required).
set -e
cd "$(dirname "$0")"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
if command -v node >/dev/null 2>&1; then
  node -e 'for (const f of ["engine.js","presets.js","tests/engine.test.js"]) require("vm").runInThisContext(require("fs").readFileSync(f,"utf8"), f)'
else
  "$JSC" engine.js presets.js tests/engine.test.js
fi
