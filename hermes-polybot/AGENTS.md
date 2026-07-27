# Agent Entry Point — Hermes Polybot

1. Read `memory/INDEX.md`. It is capped at 150 lines and is always current.
2. Read `memory/STATUS.md` for live system health.
3. Read `memory/roster.csv` only if you need all 500 wallets.
4. Read `memory/wallets/<status>/<address>.md` only for a specific address.
5. **Never** read all of `memory/wallets/` at once.

## Strict Rules

- `memory/` is a derived, write-only projection. Editing it manually changes nothing and will be overwritten on the next rescan.
- Postgres (Supabase) is the sole source of truth. To change state, change the database.
- Never commit credentials. See `docs/00-ROTATE-SECRETS.md`.
- Full build spec: `docs/` and the Foundation v2 document.
