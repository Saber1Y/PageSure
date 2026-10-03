#!/usr/bin/env bash
#
# Build the one-way-channel contracts and record their provenance.
#
# There is NO canonical deployment of these contracts: the repository publishes no
# releases, no tags, and no WASM hash. So the WASM is built from source, uploaded once,
# and the resulting hash is pinned in .env. Everything downstream uses that hash.
#
# Build:
#   git clone --depth 1 https://github.com/stellar-experimental/one-way-channel
#   cd one-way-channel
#   cargo build --target wasm32v1-none --release --lib -p channel
#   cargo build --target wasm32v1-none --release --lib -p channel-factory
#   cp target/wasm32v1-none/release/channel.wasm        <repo>/contracts/
#   cp target/wasm32v1-none/release/channel_factory.wasm <repo>/contracts/
#
# Deploy (needs a funded testnet account, see .env.example):
#   npm run channels:deploy
#
# `npm run channels:deploy` performs:
#   1. stellar contract upload  channel.wasm        -> CHANNEL_WASM_HASH
#   2. stellar contract deploy  channel_factory     -> CHANNEL_FACTORY_C
#   3. verifies factory.__constructor(admin, CHANNEL_WASM_HASH) by simulation
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="$REPO_ROOT/contracts"
SRC_REPO="https://github.com/stellar-experimental/one-way-channel"
BUILD_DIR="${PAGESURE_CONTRACT_BUILD_DIR:-/tmp/one-way-channel-build}"

CHANNEL_WASM="$CONTRACTS_DIR/channel.wasm"
FACTORY_WASM="$CONTRACTS_DIR/channel_factory.wasm"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

if [ "${1:-}" = "--build" ]; then
  step "Cloning $SRC_REPO"
  rm -rf "$BUILD_DIR"
  git clone --depth 1 "$SRC_REPO" "$BUILD_DIR"

  step "Building channel and channel-factory (wasm32v1-none, release)"
  ( cd "$BUILD_DIR"
    cargo build --target wasm32v1-none --release --lib -p channel
    cargo build --target wasm32v1-none --release --lib -p channel-factory )

  mkdir -p "$CONTRACTS_DIR"
  cp "$BUILD_DIR/target/wasm32v1-none/release/channel.wasm" "$CHANNEL_WASM"
  cp "$BUILD_DIR/target/wasm32v1-none/release/channel_factory.wasm" "$FACTORY_WASM"

  step "Recording provenance"
  ( cd "$BUILD_DIR" && git rev-parse HEAD ) > "$CONTRACTS_DIR/BUILD_PROVENANCE"
  {
    echo "source:   $SRC_REPO"
    echo "commit:   $( cd "$BUILD_DIR" && git rev-parse HEAD )"
    echo "built:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "rustc:    $(rustc --version)"
    echo "target:   wasm32v1-none"
    echo "channel:  $(shasum -a 256 "$CHANNEL_WASM" | cut -d' ' -f1)"
    echo "factory:  $(shasum -a 256 "$FACTORY_WASM" | cut -d' ' -f1)"
  } | tee "$CONTRACTS_DIR/BUILD_PROVENANCE"

  step "Done. Now run: npm run channels:deploy"
  exit 0
fi

step "Verifying WASM artifacts are present"
for f in "$CHANNEL_WASM" "$FACTORY_WASM"; do
  [ -f "$f" ] || { echo "missing $f -- run: bash scripts/build-contracts.sh --build" >&2; exit 1; }
  echo "  ok  $(basename "$f")  $(wc -c < "$f" | tr -d ' ') bytes"
done

step "Reminder"
cat <<'EOF'
Deployment is performed by the Node script so the resulting contract ids are written
back into .env in the exact format the app expects:

  npm run channels:deploy

It requires FEE_PAYER_SECRET (or STELLAR_DEPLOY_SECRET) to be set and funded on
Stellar testnet, and requires the USDC SAC trustline on the deploying account for
open() to move value.

Nothing is deployed implicitly. This script never broadcasts a transaction on its own.
EOF