# Hermes Polybot — Secret Rotation Runbook
# docs/00-ROTATE-SECRETS.md

> **Purpose:** Step-by-step guide for rotating every credential this project uses.
> Run this whenever a secret is suspected compromised, or during scheduled quarterly rotation.

---

## Prerequisites

- `gh` CLI authenticated as `behnialucas-droid`
- Access to Supabase dashboard (project: yywcdqgbilwbuifnbidz)
- Access to Telegram BotFather
- Access to GitHub repo settings

---

## Step 1 — Disable the workflow

```bash
export GH_TOKEN=<your_github_pat>
gh workflow disable loop.yml --repo behnialucas-droid/polymarket
```

This prevents the old credentials from being used while you rotate.

---

## Step 2 — Reset Supabase database password

1. Go to: https://supabase.com/dashboard/project/yywcdqgbilwbuifnbidz/settings/database
2. Click **"Reset database password"**
3. Copy the new password
4. The new URLs will be:
   - `DATABASE_URL` (pooler): `postgresql://postgres.yywcdqgbilwbuifnbidz:<NEW_PASS>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?pgbouncer=true`
   - `DIRECT_URL` (direct): `postgresql://postgres.yywcdqgbilwbuifnbidz:<NEW_PASS>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`

---

## Step 3 — Revoke Telegram Bot A token

In Telegram, message **@BotFather**:
```
/revoke
```
Select Bot A (the one with token starting with `7968...`). Copy the new token.

---

## Step 4 — Delete Telegram Bot B

In Telegram, message **@BotFather**:
```
/deletebot
```
Select Bot B (the one with token starting with `8233...`). This is permanent.

---

## Step 5 — Verify old credentials are dead

```bash
# Verify old DB password is dead (should return auth error):
node -e "
const pg = await import('postgres');
const sql = pg.default('OLD_DATABASE_URL_HERE', { ssl: 'require', max: 1, connect_timeout: 5 });
sql\`SELECT 1\`.then(() => { console.error('ERROR: old password still works!'); process.exit(1); })
  .catch(e => { console.log('✅ old DB password is dead:', e.message); sql.end(); });
"

# Verify old Telegram token is dead (should return 401):
curl -s "https://api.telegram.org/bot7968301266:AAEgrLkq01Q8k-OdCuDRu16pz0iVRafoAFw/getMe" | python3 -c "import sys,json; d=json.load(sys.stdin); print('dead?', not d.get('ok', True))"

# Verify Bot B is gone:
curl -s "https://api.telegram.org/bot8233036914:AAF699ijYWDwJebEKu__CH6QUrNvLx2TPnA/getMe" | python3 -c "import sys,json; d=json.load(sys.stdin); print('dead?', not d.get('ok', True))"
```

**Paste the output of each command above before proceeding.**

---

## Step 6 — Set new GitHub secrets

```bash
export GH_TOKEN=<your_github_pat>
REPO="behnialucas-droid/polymarket"

gh secret set DATABASE_URL            --repo $REPO
gh secret set DIRECT_URL              --repo $REPO
gh secret set TELEGRAM_BOT_TOKEN      --repo $REPO
gh secret set TELEGRAM_CHAT_ID        --repo $REPO
gh secret set WORKFLOW_DISPATCH_TOKEN --repo $REPO
```

Each command prompts you to paste the value. No values in this file.

`WORKFLOW_DISPATCH_TOKEN` must be a **fine-grained PAT** with:
- Repository access: only `behnialucas-droid/polymarket`
- Permissions: `Actions: Read and write`
- No other permissions

---

## Step 7 — Create least-privilege database role

Connect to Supabase SQL editor and run:

```sql
-- Create the role the automation uses (if not already created)
CREATE ROLE hermes_bot LOGIN PASSWORD '<strong-password>';

-- Grant only what it needs (SELECT/INSERT/UPDATE, no DELETE, no schema changes)
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO hermes_bot;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hermes_bot;

-- Prove DELETE is denied:
SET ROLE hermes_bot;
DELETE FROM "WalletProfile" LIMIT 1;  -- Must error: permission denied
RESET ROLE;
```

Note: `DATABASE_URL` uses the transaction pooler (port 6543, pgbouncer=true).
`DIRECT_URL` uses the session pooler (port 5432, for migrations only).

---

## Step 8 — Re-enable the workflow

```bash
gh workflow enable loop.yml --repo behnialucas-droid/polymarket
```

Then trigger it manually and verify it completes green:

```bash
gh workflow run loop.yml --repo behnialucas-droid/polymarket
```

---

## Step 9 — Verify the credential scan is clean

```bash
cd hermes-polybot
node --experimental-strip-types tests/secrets.test.ts
```

Must print: `✅ Credential scan clean — N files checked`

---

## Reminder: What NEVER goes in git

- Any password or API key
- Any connection string with a password (even partial)
- Bot tokens
- `secrets.X || 'literal'` fallbacks in workflows
- `FALLBACK_*` constants in source code

If any of the above is found in a PR, **block the merge** and rotate the credential immediately.
