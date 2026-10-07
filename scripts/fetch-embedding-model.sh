#!/usr/bin/env bash
# Fetch the embedding model buddy's memory is indexed with (README, "M5").
#
# potion-base-8M is a Model2Vec static embedding model: a 29,528 × 256 table of
# token vectors and a WordPiece tokenizer. Embedding a sentence is a tokenizer
# pass and a mean — no neural network runs, so there is no ML runtime to ship
# and nothing leaves the machine. MIT-licensed, ~30 MB.
#
# Pinned to one upstream revision and verified by SHA-256, because the vectors
# in a user's database were produced by these exact bytes: a silently different
# file would not crash anything, it would quietly make every stored vector
# disagree with every new one, and search would degrade with no error anywhere.
# (A *deliberate* model change is handled — buddy re-embeds on a changed model
# id — but that is a decision, not a download.)
#
# Idempotent: a file that is already present with the right hash is left alone,
# so `npm run dev` pays for this once.
set -euo pipefail

REPO="minishlab/potion-base-8M"
REV="bf8b056651a2c21b8d2565580b8569da283cab23"
DEST="$(cd "$(dirname "$0")/.." && pwd)/resources/models/potion-base-8M"

FILES=(
  "model.safetensors f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2"
  "tokenizer.json e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50"
  "config.json 2a6ac0e9aaa356a68a5688070db78fc3a464fefe85d2f06a1905ce3718687553"
  "README.md de8ec91bf63c5f4c0e20751c227b2d049953e1cab5f8d5d44211c59a44795bdd"
)

mkdir -p "$DEST"

sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

fetched=0
for entry in "${FILES[@]}"; do
  name="${entry%% *}"
  want="${entry##* }"
  out="$DEST/$name"
  if [[ -f "$out" && "$(sha "$out")" == "$want" ]]; then
    continue
  fi
  tmp="$(mktemp "$DEST/.$name.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  echo "fetch-embedding-model: downloading $name"
  curl -fsSL --retry 3 -o "$tmp" "https://huggingface.co/$REPO/resolve/$REV/$name"
  got="$(sha "$tmp")"
  if [[ "$got" != "$want" ]]; then
    echo "fetch-embedding-model: $name has SHA-256 $got, expected $want — refusing to install it" >&2
    exit 1
  fi
  chmod 644 "$tmp"
  mv "$tmp" "$out"
  trap - EXIT
  fetched=$((fetched + 1))
done

echo "$REV" > "$DEST/REVISION"
if [[ $fetched -gt 0 ]]; then
  echo "fetch-embedding-model: $REPO@${REV:0:7} ready in resources/models/"
fi
