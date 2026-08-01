# 00 — Preflight and safe execution

## Goal

Prove the agent is in the intended repository before it edits anything.

## Commands

```sh
set -eu
git rev-parse --show-toplevel
pwd
git status --short
find hermes-polybot/runtime hermes-polybot/dashboard hermes-polybot/docs -maxdepth 2 -type d | sort
```

Expected Git root:

```text
/home/nima/Documents/claude.app/polymarket-repo
```

Expected application root:

```text
/home/nima/Documents/claude.app/polymarket-repo/hermes-polybot
```

If either differs, output `BLOCKED` and stop.

## Before edit

Read:

```sh
cat hermes-polybot/AGENTS.md
cat hermes-polybot/memory/INDEX.md 2>/dev/null || true
cat hermes-polybot/memory/STATUS.md 2>/dev/null || true
cat hermes-polybot/docs/PROMPTS/00-SYSTEM.md
```

Record the initial `git status --short`. Existing modifications belong to the operator, not this card. Never reset, clean, stash, commit, push, or overwrite them.

## Safety scans

```sh
cd hermes-polybot/runtime
npm ls --depth=0
find src scripts tests -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 grep -nE 'privateKey|signTransaction|signTypedData|ethers|viem|web3|PRIVATE_KEY|MNEMONIC|SEED_PHRASE' || true
find src scripts tests -type f \( -name '*.ts' -o -name '*.tsx' \) -print0 | xargs -0 grep -nE 'method:[[:space:]]*["'"'](POST|PUT|DELETE)' || true
```

If an unexpected dependency, key access, or mutation endpoint appears, stop. Do not delete it blindly; report file and line.

## Required output

Report root, baseline status, scan output, and `PASS` only if all prerequisites are proven. This card makes no code changes.
