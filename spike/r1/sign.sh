#!/bin/bash
# R1 spike signing. $1 = .app path, $2 = identity (default ad-hoc "-"), $3 = bundle id
set -euo pipefail
APP="$1"; ID="${2:--}"; BID="${3:-com.cyrus.buddy.spike}"
sign() { codesign --force --timestamp=none --sign "$ID" "$@"; }

# Inner frameworks and helpers first, deepest last-modified-first.
find "$APP/Contents/Frameworks" -name "*.dylib" -exec codesign --force --sign "$ID" {} \; 2>/dev/null || true
for h in "$APP/Contents/Frameworks/"*.app; do [ -e "$h" ] && sign "$h"; done
for f in "$APP/Contents/Frameworks/"*.framework; do
  [ -e "$f" ] || continue
  for v in "$f/Versions/"*/; do [ "$(basename "$v")" = "Current" ] && continue; sign "$v"; done
  sign "$f"
done
for h in "$APP/Contents/Frameworks/Electron Framework.framework/Helpers/"*; do [ -e "$h" ] && sign "$h"; done
# The sidecar, with its own identifier.
sign --identifier "$BID.buddyd" "$APP/Contents/MacOS/buddyd-spike"
# The outer bundle last; its identifier is what TCC keys on.
sign --identifier "$BID" "$APP"
