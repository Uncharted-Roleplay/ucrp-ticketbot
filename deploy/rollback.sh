#!/usr/bin/env bash
# Switch ucrp-ticketbot on OVH back to the previous release and restart it.
#   deploy/rollback.sh
set -euo pipefail
REPO="$(git rev-parse --show-toplevel)"
ssh ovh "bash -s -- rollback" < "$REPO/deploy/remote.sh"
