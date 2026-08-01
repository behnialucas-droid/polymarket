# Hermes Everything: controlled paper-research pack

This pack is an implementation specification for a read-only, paper-only research system. It cannot authorize real orders, signing, wallet credentials, or claims of future performance.

## Execution order

1. `00-PREFLIGHT.md` — establish root, dirty-tree boundary, safety scan, baseline.
2. `01-RULES-HORIZON.md` — freeze rule schema, clock, horizon and rejection semantics.
3. `02-RESEARCH-INTEGRITY.md` — implement event identity, immutable snapshots, as-of joins and cohort provenance.
4. `03-PNL-SETTLEMENT.md` — select and implement an explicit paper accounting model.
5. `04-RELIABILITY.md` — make ingest, replay, leases, migrations and failures durable.
6. `05-DASHBOARD-DEPLOY.md` — keep execution off ephemeral dashboard infrastructure.
7. `06-MONTH-TRIAL.md` — preregister and monitor an exploratory evaluation.
8. `07-RELEASE-ROLLBACK.md` — release additive changes with backup and evidence.
9. `08-UPDATE-PROTOCOL.md` — version every research or operational change.
10. `09-FINAL-AUDIT.md` — close only with command/query evidence.
11. `10-PREREGISTRATION.md` — freeze the ≥30-day trial protocol before the first observation.
12. `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md` — normative data, position, cost and risk contract.
13. `APPENDIX-B-TRIAL-AND-SCENARIO-TEMPLATES.md` — trial manifests and predeclared scenario matrix.

Run one card per agent session. Never skip prerequisites. If path, anchor, schema, or precondition differs, stop with `BLOCKED`.

## Runbooks (operational procedures)

Cards 00–10 are governance: they define contracts and acceptance. Runbooks are agent-executable operational procedures that implement those contracts on a real machine. Execute in order on first bring-up; individually thereafter.

1. `RUNBOOK-01-INSTALL.md` — clone, Node 22 check, `npm ci`, env NAMES, offline verify.
2. `RUNBOOK-02-DB-MIGRATE.md` — backup, `npm run migrate`, `SchemaMigration` verification, rollback posture.
3. `RUNBOOK-03-RUN-CYCLE.md` — demo replay (deterministic clock), live cycle, invariant SQL evidence.
4. `RUNBOOK-04-DASHBOARD-DEPLOY.md` — port 4000 dev/build/start, systemd, read-only production boundary.
5. `RUNBOOK-05-SCHEDULER.md` — GHA or systemd; exactly one scheduler owner.
6. `RUNBOOK-06-TELEGRAM.md` — bot setup, chat id, delivery verification, redaction policy.
7. `RUNBOOK-07-TROUBLESHOOTING.md` — DNS/pooler, RunLock lease, heartbeats, GHA auto-disable, fixtures, migrations.

Runbooks never override governance: on conflict, cards 00–10 and the appendices win. Secrets appear as env var NAMES only, everywhere.

## Pack governance

- `runtime/` is authoritative over mirrored dashboard libraries.
- Postgres is runtime source of truth. `memory/` is derived and must not be manually edited.
- Raw provider records and research evidence are append-only. Corrections append provenance; they do not overwrite history.
- Existing standalone `TASK-*.md` cards remain historical backlog. They are superseded by this pack when contracts conflict; do not execute them silently.
- Every implementation card must state scope, allowed files, migration/reversibility plan, tests, actual output, blockers, and rollback.

## Hard boundaries

- No private key, mnemonic, seed phrase, wallet library, signing call, order endpoint, or real trade.
- Adapters remain public-data read-only. Database writes are paper ledger/research evidence only.
- No fabricated market, quote, resolution, wallet, fill, or API result.
- Unknown, stale, invalid, disputed, or missing data is recorded as a structured rejection/blocker; never converted to a convenient value.
- `SELL` is never silently treated as `BUY`, short, or a negative long. See Appendix A.
- One month of paper observations is exploratory. It cannot prove profitability, safety, edge, or future live performance.

## Evidence standard

A card is `verified` only when its declared commands and database checks actually pass. `applied` means code or documents changed but verification is incomplete. `blocked` means an external prerequisite such as database/network access is unavailable. Never report blocked checks as passed.

Every metric must declare:

- analysis period and UTC clock;
- cohort, rule, score, accounting and cost-model versions;
- raw count and denominator;
- decision-time coverage and missing/stale rate;
- capital-at-risk, open exposure, turnover and drawdown denominator;
- fees, spread, slippage, impact, latency and partial-fill assumptions;
- unresolved/invalidated treatment;
- uncertainty interval and sample-size warning.

## State ledger

`STATE.json` stores pack version, immutable specification hash when known, card status, prerequisites, implementation revision, migration checksum, verification command/result, and blockers. A `PASS` conclusion requires `verified` plus evidence fields.
