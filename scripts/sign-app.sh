#!/bin/bash
# Sign a built buddy.app with the local self-signed identity.
#
# electron-builder signs the bundle, but the sidecar in Contents/MacOS/ has to
# be signed *before* the outer bundle or the outer seal will not cover it — and
# a sidecar whose signature does not match the app is the R1 failure mode we set
# out to avoid.
#
# Usage: ./scripts/sign-app.sh release/mac-arm64/buddy.app
set -euo pipefail
APP="${1:-release/mac-arm64/buddy.app}"
[ -d "$APP" ] || { echo "No app bundle at $APP" >&2; exit 1; }

ID="${BUDDY_SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"buddy Local Dev"' | head -1 | tr -d '"' || true)}"
if [ -z "$ID" ]; then
  echo "No 'buddy Local Dev' identity. Run ./scripts/make-signing-cert.sh first." >&2
  echo "Falling back to ad-hoc — Screen Recording WILL be revoked on the next build (PRD R2)." >&2
  ID="-"
fi

sign() { codesign --force --timestamp=none --sign "$ID" "$@"; }

find "$APP/Contents/Frameworks" -name '*.dylib' -exec codesign --force --sign "$ID" {} \; 2>/dev/null || true
for h in "$APP/Contents/Frameworks/"*.app; do [ -e "$h" ] && sign "$h"; done
for f in "$APP/Contents/Frameworks/"*.framework; do
  [ -e "$f" ] || continue
  for v in "$f/Versions/"*/; do [ "$(basename "$v")" = "Current" ] && continue; sign "$v"; done
  sign "$f"
done
for h in "$APP/Contents/Frameworks/Electron Framework.framework/Helpers/"*; do [ -e "$h" ] && sign "$h"; done

# The sidecar, then the bundle. Order matters: the outer seal must cover it.
[ -f "$APP/Contents/MacOS/buddyd" ] && sign --identifier com.cyrus.buddy.buddyd "$APP/Contents/MacOS/buddyd"
sign --identifier com.cyrus.buddy "$APP"

echo
codesign -dvvv "$APP" 2>&1 | grep -E 'Identifier|Signature|CDHash|Authority' || true
codesign --verify --strict --verbose=1 "$APP" 2>&1 | tail -2
