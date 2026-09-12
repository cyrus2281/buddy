#!/bin/bash
# Create a free, self-signed code-signing identity for buddy and put it in the
# login keychain.
#
# Why this exists (PRD R2): an ad-hoc signature (`codesign -s -`) produces a new
# cdhash on every build. TCC records the grant against that hash, so the next
# build silently loses Screen Recording while System Settings still shows the
# toggle ON. That failure was reproduced during the R1 spike and it is
# indistinguishable from a bug in the capture code.
#
# A self-signed certificate gives the bundle a stable Designated Requirement, so
# the grant survives rebuilds. No Apple Developer account, no Xcode, no cost.
#
# Run once:   ./scripts/make-signing-cert.sh
# Then build: npm run build:sidecar && npm run dist
set -euo pipefail

CN="${BUDDY_SIGNING_CN:-buddy Local Dev}"
KEYCHAIN="${HOME}/Library/Keychains/login.keychain-db"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if security find-identity -v -p codesigning | grep -qF "$CN"; then
  echo "✓ Signing identity \"$CN\" already exists. Nothing to do."
  security find-identity -v -p codesigning | grep -F "$CN"
  exit 0
fi

echo "Creating self-signed code-signing certificate \"$CN\"…"

cat > "$WORK/ext.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3

[dn]
CN = $CN

[v3]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" -config "$WORK/ext.cnf" 2>/dev/null

# The PKCS#12 needs a non-empty password. macOS's importer fails MAC
# verification on an empty-password bundle ("wrong password?") no matter which
# cipher produced it, so the passphrase is generated here, used twice, and
# thrown away with $WORK — it protects a file that exists for one second.
P12PASS="$(openssl rand -hex 16)"

# -legacy asks OpenSSL 3 for the RC2/3DES encoding the Security framework can
# read; without it a modern AES-256 bundle imports as an opaque blob. Older
# OpenSSL has no such flag and already defaults to it, hence the fallback.
openssl pkcs12 -export -legacy \
  -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/identity.p12" -passout "pass:$P12PASS" -name "$CN" 2>/dev/null \
  || openssl pkcs12 -export \
       -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
       -out "$WORK/identity.p12" -passout "pass:$P12PASS" -name "$CN"

# -T scopes the private key's access to codesign rather than every app.
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$P12PASS" \
  -T /usr/bin/codesign -T /usr/bin/security

# Trust it for code signing in the *user* domain — no admin password, and it
# grants nothing beyond "this machine believes signatures made by this key".
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem" \
  || echo "  (trust step skipped — codesign still works, verification just warns)"

echo
echo "✓ Done. Identity:"
security find-identity -v -p codesigning | grep -F "$CN" || {
  echo "  Certificate imported but not listed as a codesigning identity."
  echo "  Open Keychain Access → login → My Certificates, find \"$CN\","
  echo "  and set its trust for Code Signing to \"Always Trust\"."
  exit 1
}
echo
echo "The first buddy build signed with this will ask for Screen Recording once."
echo "Every rebuild after that keeps the grant."
