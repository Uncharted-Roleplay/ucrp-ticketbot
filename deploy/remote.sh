#!/usr/bin/env bash
# Server-side release management for ucrp-ticketbot. Runs ON THE SERVER as root;
# deploy.sh / rollback.sh pipe it over ssh.
#
#   remote.sh activate <release>   unpack releases/.incoming-<release>.tgz, wire it
#                                  to the shared config/data, switch `current`,
#                                  restart and health-check (auto-rollback)
#   remote.sh rollback             switch `current` to the previous release
set -euo pipefail

APP=/opt/ucrp-ticketbot
SVC=ticketbot
UNIT=ucrp-ticketbot
NODE="$APP/runtime/node/bin/node"
KEEP=5
HEALTH_TIMEOUT=45

log()  { printf '[remote] %s\n' "$*"; }
fail() { printf '[remote] ERROR: %s\n' "$*" >&2; exit 1; }

# Releases, newest first (by directory mtime).
releases() { find "$APP/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-; }

token_set() { grep -Eq '^TOKEN=.+' "$APP/shared/.env"; }

switch_to() {
  ln -sfn "$1" "$APP/current.new"
  mv -T "$APP/current.new" "$APP/current"
  log "current -> $(basename "$1")"
}

# Restart and wait for the bot's "Logged in as" line. Returns non-zero on timeout.
restart_and_check() {
  local since; since="@$(date +%s)"
  systemctl restart "$UNIT"
  for _ in $(seq "$HEALTH_TIMEOUT"); do
    if journalctl -u "$UNIT" --since "$since" --no-pager -q | grep -q 'Logged in as'; then
      log "healthy: bot logged in"
      return 0
    fi
    sleep 1
  done
  journalctl -u "$UNIT" --since "$since" --no-pager -q | tail -n 30 >&2 || true
  return 1
}

activate() {
  local rel="$1"
  [[ "$rel" =~ ^[0-9A-Za-z._-]+$ ]] || fail "bad release name: $rel"
  local dir="$APP/releases/$rel" tgz="$APP/releases/.incoming-$rel.tgz"
  [ -f "$tgz" ] || fail "missing upload $tgz"
  [ -x "$NODE" ] || fail "node runtime missing at $NODE"

  rm -rf "$dir"
  mkdir "$dir"
  tar -xzf "$tgz" -C "$dir"
  rm -f "$tgz"

  # Shared state: config and data live outside the release so they survive
  # deploys. The shipped examples are kept next to the live config for reference.
  install -o root -g "$SVC" -m 640 "$dir"/config/*.example.jsonc "$APP/shared/config/"
  for name in config snippets; do
    if [ ! -f "$APP/shared/config/$name.jsonc" ]; then
      install -o root -g "$SVC" -m 640 "$APP/shared/config/$name.example.jsonc" "$APP/shared/config/$name.jsonc"
      log "seeded shared/config/$name.jsonc from the example"
    fi
  done
  rm -rf "$dir/config" "$dir/data"
  ln -s "$APP/shared/config" "$dir/config"
  ln -s "$APP/data" "$dir/data"

  chown -R root:"$SVC" "$dir"
  chmod -R u=rwX,g=rX,o= "$dir"

  # Smoke test as the service user: the runtime and every module load.
  runuser -u "$SVC" -- "$NODE" -e "
    process.chdir('$dir');
    require('$dir/node_modules/discord.js');
    require('$dir/node_modules/pg');
    require('$dir/src/client.js');
    require('$dir/src/utils/ticketActions.js');
  " || fail "smoke test failed, current release untouched"
  log "smoke test passed"

  local prev=""
  [ -L "$APP/current" ] && prev="$(readlink -f "$APP/current")"
  switch_to "$dir"

  if ! token_set; then
    log "TOKEN is empty in shared/.env: release installed but NOT started."
    log "Fill in TOKEN/CLIENT_ID, then: systemctl start $UNIT"
    prune "$dir"
    return 0
  fi

  if restart_and_check; then
    prune "$dir"
    return 0
  fi

  if [ -n "$prev" ] && [ "$prev" != "$dir" ]; then
    log "health check failed: rolling back to $(basename "$prev")"
    switch_to "$prev"
    restart_and_check || log "previous release is not healthy either, check: journalctl -u $UNIT"
  else
    systemctl stop "$UNIT"
    log "health check failed and there is no previous release: service stopped"
  fi
  fail "deploy of $rel failed"
}

rollback() {
  [ -L "$APP/current" ] || fail "no current release"
  local cur prev=""
  cur="$(readlink -f "$APP/current")"
  while read -r r; do
    if [ "$r" != "$cur" ]; then prev="$r"; break; fi
  done < <(releases)
  [ -n "$prev" ] || fail "no previous release to roll back to"
  switch_to "$prev"
  # Mark it newest so a second rollback goes further back, not forth.
  touch "$prev"
  touch "$cur" -d '1970-01-02'
  restart_and_check || fail "rolled back, but the bot did not log in; check journalctl -u $UNIT"
}

# Keep the newest $KEEP releases plus whatever `current` points at.
prune() {
  local keep_dir="$1" n=0
  while read -r r; do
    n=$((n + 1))
    if [ "$n" -gt "$KEEP" ] && [ "$r" != "$keep_dir" ]; then
      rm -rf "$r"
      log "pruned $(basename "$r")"
    fi
  done < <(releases)
}

case "${1:-}" in
  activate) activate "${2:?release name required}" ;;
  rollback) rollback ;;
  *) fail "usage: remote.sh activate <release> | rollback" ;;
esac
