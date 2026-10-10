#!/usr/bin/env bash
# One-time server preparation: ships server-setup.sh + the systemd unit to OVH
# and runs it as root. Idempotent; never overwrites .env, config or the DB.
#   deploy/setup.sh <guild-id>
set -euo pipefail
GUILD_ID="${1:?usage: deploy/setup.sh <guild-id>}"
[[ "$GUILD_ID" =~ ^[0-9]{17,20}$ ]] || { echo "not a Discord guild id: $GUILD_ID" >&2; exit 1; }

REPO="$(git rev-parse --show-toplevel)"
REMOTE_TMP="/tmp/ucrp-ticketbot-setup"
tar -C "$REPO/deploy" -cf - server-setup.sh ucrp-ticketbot.service \
  | ssh ovh "rm -rf $REMOTE_TMP && mkdir -m 700 $REMOTE_TMP && tar -xf - -C $REMOTE_TMP && bash $REMOTE_TMP/server-setup.sh $GUILD_ID; rc=\$?; rm -rf $REMOTE_TMP; exit \$rc"
