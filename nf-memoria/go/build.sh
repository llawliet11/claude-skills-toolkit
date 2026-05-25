#!/usr/bin/env bash
# Build the resolve-memory-folder binary for the current OS/arch into ../bin/.
# Pass --all to also cross-compile darwin-arm64 + linux-amd64 + linux-arm64
# (binaries land in ../bin/resolve-memory-folder-<os>-<arch>).
#
# Usage:
#   ./build.sh         # current OS/arch
#   ./build.sh --all   # all 3 supported targets
set -euo pipefail

cd "$(dirname "$0")"
SKILL_ROOT="$(cd .. && pwd)"
BIN_DIR="$SKILL_ROOT/bin"
mkdir -p "$BIN_DIR"

build_one() {
  local goos="$1" goarch="$2" tag="$3"
  local out="$BIN_DIR/resolve-memory-folder"
  if [ -n "$tag" ]; then out="$BIN_DIR/resolve-memory-folder-$tag"; fi
  echo "build: GOOS=$goos GOARCH=$goarch -> $out"
  GOOS="$goos" GOARCH="$goarch" CGO_ENABLED=0 \
    go build -trimpath -ldflags="-s -w" -o "$out" .
}

if [ "${1:-}" = "--all" ]; then
  build_one darwin arm64 darwin-arm64
  build_one linux  amd64 linux-amd64
  build_one linux  arm64 linux-arm64
else
  build_one "$(go env GOOS)" "$(go env GOARCH)" ""
fi

ls -lh "$BIN_DIR"
