#!/usr/bin/env bash
# One-time, idempotent preparation of the OVH host for ucrp-ticketbot.
# Runs ON THE SERVER as root (deploy/setup.sh ships and runs it). Safe to re-run:
# it never overwrites an existing .env, config or database.
set -euo pipefail

APP=/opt/ucrp-ticketbot
SVC=ticketbot          # system user, Postgres role and database share this name
GUILD_ID_DEFAULT="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[setup] %s\n' "$*"; }

# ── User and directories ──────────────────────────────────────────────────────
if ! id -u "$SVC" >/dev/null 2>&1; then
  useradd --system --home-dir "$APP/data" --no-create-home --shell /usr/sbin/nologin "$SVC"
  log "created system user $SVC"
fi

install -d -o root -g root -m 755 "$APP" "$APP/releases" "$APP/runtime"
install -d -o root -g "$SVC" -m 750 "$APP/shared" "$APP/shared/config"
install -d -o "$SVC" -g "$SVC" -m 750 "$APP/data"

# ── Database ──────────────────────────────────────────────────────────────────
ENV_FILE="$APP/shared/.env"
psql_q() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"; }

if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE"; then
  log "DATABASE_URL already present in .env, leaving the database credentials alone"
else
  # The password goes straight from here into the .env file; it is never printed.
  PW="$(openssl rand -hex 24)"
  # Statements carrying the password go through stdin, not argv, so they never
  # show up in the process list.
  if [ "$(psql_q -c "SELECT 1 FROM pg_roles WHERE rolname = '$SVC'")" = "1" ]; then
    printf "ALTER ROLE %s WITH LOGIN PASSWORD '%s';\n" "$SVC" "$PW" | psql_q >/dev/null
    log "reset password of existing role $SVC (no DATABASE_URL was on file)"
  else
    printf "CREATE ROLE %s LOGIN PASSWORD '%s' NOSUPERUSER NOCREATEDB NOCREATEROLE CONNECTION LIMIT 25;\n" "$SVC" "$PW" | psql_q >/dev/null
    log "created role $SVC"
  fi
  DB_URL_LINE="DATABASE_URL=postgres://$SVC:$PW@127.0.0.1:5432/$SVC"
  unset PW
fi

if [ "$(psql_q -c "SELECT 1 FROM pg_database WHERE datname = '$SVC'")" != "1" ]; then
  psql_q -c "CREATE DATABASE $SVC OWNER $SVC" >/dev/null
  psql_q -c "REVOKE ALL ON DATABASE $SVC FROM PUBLIC" >/dev/null
  log "created database $SVC"
fi

# ── .env skeleton (secrets are filled in by hand, never through chat) ─────────
if [ ! -f "$ENV_FILE" ]; then
  install -o root -g root -m 600 /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# ucrp-ticketbot environment. Loaded by systemd (EnvironmentFile), not dotenv.
# Fill in TOKEN and CLIENT_ID from the Discord developer portal.
TOKEN=
CLIENT_ID=
GUILD_ID=$GUILD_ID_DEFAULT
# No MSK key on purpose: transcripts stay on our side (log channel file).
MSK_API_KEY=
DASHBOARD_ENABLED=false
EOF
  log "wrote .env skeleton (TOKEN and CLIENT_ID still empty)"
fi
if [ -n "${DB_URL_LINE:-}" ]; then
  sed -i '/^DATABASE_URL=/d' "$ENV_FILE"
  printf '%s\n' "$DB_URL_LINE" >> "$ENV_FILE"
  unset DB_URL_LINE
  log "stored DATABASE_URL in .env"
fi
# Only systemd (root) reads this file; the bot receives the values as its
# environment and cannot open the file itself.
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ── systemd unit ──────────────────────────────────────────────────────────────
install -o root -g root -m 644 "$HERE/ucrp-ticketbot.service" /etc/systemd/system/ucrp-ticketbot.service
systemctl daemon-reload
systemctl enable ucrp-ticketbot.service >/dev/null 2>&1
log "installed and enabled ucrp-ticketbot.service (not started)"

log "done"
