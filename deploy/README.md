# Deploying ucrp-ticketbot (OVH)

UCRP-specific; not part of upstream. Everything runs from **Git Bash on Windows**;
nothing is built on the server.

## Layout on the server

```
/opt/ucrp-ticketbot/
  runtime/node -> node-v24.x-linux-x64   private Node 24 (system Node 22 untouched)
  releases/<version>-<sha>/              code + node_modules, root-owned, read-only to the bot
  current -> releases/…                  what the service runs
  shared/.env                            secrets (root 600, read by systemd only)
  shared/config/{config,snippets}.jsonc  live config (+ *.example.jsonc for reference)
  data/                                  the only directory the bot can write
```

Service: `ucrp-ticketbot.service`, user `ticketbot`, logs in `journalctl -u ucrp-ticketbot`.
Database: role and database `ticketbot` on the local PostgreSQL 16 (backed up by the
nightly `pg_dumpall`); `shared/` is in the restic backup.

## Commands

| What | Command |
|---|---|
| First-time server prep (idempotent) | `deploy/setup.sh <guild-id>` |
| Deploy the committed HEAD (or a ref) | `deploy/deploy.sh [ref]` |
| Build only, no server contact | `BUILD_ONLY=1 deploy/deploy.sh` |
| Roll back to the previous release | `deploy/rollback.sh` |
| Logs | `ssh ovh journalctl -u ucrp-ticketbot -f` |

`deploy.sh` runs the tests, installs runtime deps, uploads the release, smoke-tests
it as the service user, switches `current`, restarts and waits for the bot to log
in. If it does not, it switches back to the previous release automatically. The
last 5 releases are kept.

## Secrets

Never paste the bot token into chat or a commit. Edit it on the server in your own
terminal: `ssh ovh nano /opt/ucrp-ticketbot/shared/.env` (TOKEN, CLIENT_ID), then
`ssh ovh systemctl restart ucrp-ticketbot`.

## Config changes

Edit `shared/config/config.jsonc` on the server (or keep a copy here and upload it),
then `ssh ovh systemctl restart ucrp-ticketbot`. Keep the "Powered by MSK" panel
footer: it is required by the AGPL §7(b) term in `NOTICE`.
