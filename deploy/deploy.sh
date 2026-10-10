#!/usr/bin/env bash
# Build a release on Windows (Git Bash) and activate it on OVH.
#
#   deploy/deploy.sh [git-ref]      default: HEAD
#
# Builds from the COMMITTED tree (git archive), so uncommitted edits are never
# shipped. Nothing is built on the server: node_modules is installed here. The
# only native module (better-sqlite3) ships prebuilt binaries for every
# platform, so a Windows install runs unchanged on Linux.
set -euo pipefail

HOST=ovh
APP=/opt/ucrp-ticketbot
NODE_VERSION=v24.20.0
NODE_DIST="node-$NODE_VERSION-linux-x64"

REF="${1:-HEAD}"
REPO="$(git rev-parse --show-toplevel)"
SHA="$(git -C "$REPO" rev-parse --short=8 "$REF^{commit}")"
VERSION="$(git -C "$REPO" show "$REF:package.json" | node -pe 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
REL="$VERSION-$SHA"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

log() { printf '[deploy] %s\n' "$*"; }

if [ "$REF" = "HEAD" ] && [ -n "$(git -C "$REPO" status --porcelain)" ]; then
  log "note: uncommitted changes are NOT part of this release (building $SHA)"
fi

# ── 1. Export and test ────────────────────────────────────────────────────────
log "building release $REL"
mkdir "$WORK/src"
git -C "$REPO" archive "$SHA" | tar -x -C "$WORK/src"
(
  cd "$WORK/src"
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  npm test --silent >"$WORK/test.log" 2>&1 || { cat "$WORK/test.log"; echo "[deploy] tests failed" >&2; exit 1; }
  grep -E '^ℹ (pass|fail)' "$WORK/test.log" | sed 's/^/[deploy] tests: /'

  # Runtime install: no dev and no optional deps (express/helmet are only for
  # the web dashboard, which we do not run).
  rm -rf node_modules
  npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error

  # Not needed at runtime. LICENSE.md and NOTICE stay (AGPL attribution).
  rm -rf tests web docs graphify-out .github deploy Dockerfile docker-compose.yml \
         docker-entrypoint.sh ticketbot.service .dockerignore .env.example
)
tar -C "$WORK/src" -czf "$WORK/release.tgz" .
log "release archive: $(du -h "$WORK/release.tgz" | cut -f1)"

# BUILD_ONLY=1: stop here and keep the archive (no server contact).
if [ "${BUILD_ONLY:-}" = "1" ]; then
  cp "$WORK/release.tgz" "$REPO/deploy/release-$REL.tgz"
  log "BUILD_ONLY: wrote deploy/release-$REL.tgz, server untouched"
  exit 0
fi

# ── 2. Node runtime (once per version) ────────────────────────────────────────
if ! ssh "$HOST" "test -x $APP/runtime/$NODE_DIST/bin/node"; then
  log "installing $NODE_DIST on the server"
  curl -fsSL -o "$WORK/$NODE_DIST.tar.xz" "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.xz"
  curl -fsSL -o "$WORK/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  ( cd "$WORK" && grep " $NODE_DIST.tar.xz\$" SHASUMS256.txt | sha256sum -c - ) \
    || { echo "[deploy] node checksum mismatch" >&2; exit 1; }
  ssh "$HOST" "tar -xJf - -C $APP/runtime && chown -R root:root $APP/runtime/$NODE_DIST" < "$WORK/$NODE_DIST.tar.xz"
fi

# ── 3. Upload and activate ────────────────────────────────────────────────────
# Few connections on purpose: OVH rate-limits SSH (ufw limit), and a burst of
# reconnects locks us out for a while.
ssh "$HOST" "cat > $APP/releases/.incoming-$REL.tgz" < "$WORK/release.tgz"
ssh "$HOST" "bash -s -- activate $REL $NODE_DIST" < "$REPO/deploy/remote.sh"
log "done: $REL"
