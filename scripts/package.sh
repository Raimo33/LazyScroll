#!/usr/bin/env bash
# Builds the zip to upload to the Chrome Web Store: only what the extension needs at runtime.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(node -p "require('./manifest.json').version")
out="dist/lazyscroll-$version.zip"
mkdir -p dist
rm -f "$out"
zip -qr -X "$out" manifest.json icons src vendor -x "*.md"
echo "$out ($(du -h "$out" | cut -f1))"
