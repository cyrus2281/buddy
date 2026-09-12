#!/bin/bash
# Build buddyd, buddy's macOS sidecar.
#
# Deliberately plain swiftc against the Command Line Tools SDK: no Xcode, no
# Apple Developer account, no Swift package manifest to keep in sync. The whole
# sidecar is seven files and nothing about it needs a build system.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${BUDDY_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk}"
OUT="build/buddyd"
TARGET="${BUDDY_TARGET:-arm64-apple-macos14.0}"

[ -d "$SDK" ] || { echo "SDK not found at $SDK — install the Command Line Tools" >&2; exit 1; }

mkdir -p build
echo "Building buddyd → $OUT  (target $TARGET)"
swiftc -O \
  -sdk "$SDK" \
  -target "$TARGET" \
  -framework ScreenCaptureKit \
  -framework ApplicationServices \
  -framework CoreGraphics \
  -framework AppKit \
  -o "$OUT" \
  Sources/RPC.swift \
  Sources/Capture.swift \
  Sources/Displays.swift \
  Sources/System.swift \
  Sources/AXTree.swift \
  Sources/Input.swift \
  Sources/main.swift

# Signed here with the same identity as the app so a dev-mode run matches the
# packaged arrangement R1 validates. electron-builder re-signs it in place.
# `|| true` because grep exits 1 when the identity is absent, which is the
# normal first-run state and not a build failure.
FOUND="$(security find-identity -v -p codesigning 2>/dev/null \
  | grep -o '"buddy Local Dev"' | head -1 | tr -d '"' || true)"
IDENTITY="${BUDDY_SIGN_IDENTITY:-$FOUND}"
if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --identifier com.cyrus.buddy.buddyd "$OUT"
  echo "Signed with: $IDENTITY"
else
  codesign --force --sign - --identifier com.cyrus.buddy.buddyd "$OUT"
  echo "Signed ad-hoc (no 'buddy Local Dev' identity found)."
  echo "  Screen Recording will be revoked on every rebuild — PRD R2."
  echo "  Fix once with: ./scripts/make-signing-cert.sh"
fi

echo "✓ $OUT  ($(du -h "$OUT" | cut -f1))"
