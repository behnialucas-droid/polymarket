# 08 — Safe update protocol

Run this card for every future update. Normative event/accounting rules live in `APPENDIX-A-DATA-ACCOUNTING-CONTRACT.md`; trial changes use Appendix B.

1. Read `AGENTS.md`, `memory/INDEX.md`, `memory/STATUS.md`, `everything/README.md`, and relevant appendices.
2. Confirm root with `git rev-parse --show-toplevel`.
3. Capture `git status --short`, current revision, pack version, and state ledger.
4. Read target files and confirm exact anchors. Do not guess paths or silently use stale copies.
5. State scope, allowed files, dependencies, migration/reversibility, rollback, and verification before editing.
6. Preserve pre-existing dirty work. Make minimal change. No keys, signing, orders, or external mutation.
7. Version every rule, score, cohort, accounting, cost, schema, and metric change.
8. Separate training/validation from untouched evaluation. Never tune on test or one-month trial outcomes.
9. Run focused tests, full offline tests, `git diff --check`, mirror guard, typecheck/build as applicable.
10. Run migration/replay/settlement checks only with real database and source access. Otherwise return `BLOCKED`.
11. Inspect logs, network, error, coverage, reconciliation and provenance output. Never fabricate live success.
12. Update `STATE.json` only after declared evidence passes; record command, exact result, revision, migration checksum and blockers.
13. Report changed/unchanged files, commands/output, result, rollback, limitations, and exact next card.

Do not tune rules, thresholds, cohort, cost, sizing, or evaluation metrics based on failing test or favorable outcome. Fix contract or stop.
