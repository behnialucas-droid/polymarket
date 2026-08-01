/** Read-only safety: prove the codebase cannot trade, sign, or hold keys. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../src/lib/env.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function allSourceFiles(dir: string, out: string[] = []): string[] {
  // The runtime tree has no app/ directory — the dashboard lives in a sibling package.
  // Tolerate that instead of throwing, otherwise the whole safety suite aborts on import
  // and the paper-only guarantees go unchecked.
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) allSourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}

const files = [...allSourceFiles(join(ROOT, 'src')), ...allSourceFiles(join(ROOT, 'scripts')), ...allSourceFiles(join(ROOT, 'app'))];

test('no signing or private key code anywhere', () => {
  const banned = [/privateKey/i, /signTransaction/i, /signTypedData/i, /mnemonic/i, /seed\s*phrase/i, /ethers\.Wallet/, /new\s+Wallet\(/];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const b of banned) {
      // allow mentions inside comments about NOT doing it
      const lines = src.split('\n').filter((l) => b.test(l) && !/never|no |not |NOT|forbidden|redact|private-key shaped/i.test(l));
      assert.equal(lines.length, 0, `${f} contains banned pattern ${b}: ${lines[0] ?? ''}`);
    }
  }
});

test('no order-placement endpoints; adapters are GET-only', () => {
  const adapterDir = join(ROOT, 'src', 'lib', 'adapters');
  for (const f of allSourceFiles(adapterDir)) {
    const src = readFileSync(f, 'utf8');
    assert.ok(!/\/order/i.test(src), `${f} references an order endpoint`);
    assert.ok(!/method:\s*['"](POST|PUT|DELETE)/i.test(src), `${f} makes non-GET requests`);
  }
});

test('the only POST in the codebase is the optional Telegram report', () => {
  let posts = 0;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const m = src.match(/method:\s*['"]POST['"]/g);
    if (m) {
      posts += m.length;
      // Allowed POSTs, none of which move funds:
      //   telegram.ts / report*.ts  -> sendMessage to the Telegram bot API
      //   rescan.ts                 -> workflow_dispatch to api.github.com
      //   AutoRefresh.tsx           -> dashboard's own /api/cycle trigger
      assert.match(f, /(reports?|telegram|rescan)\.ts$|AutoRefresh\.tsx$/, `unexpected POST in ${f}`);
    }
  }
  assert.ok(posts <= 4, 'more POSTs than Telegram send, GitHub dispatch, and AutoRefresh trigger');
});

test('paper trade size constraint enforced at DB level', () => {
  const sql = readFileSync(join(ROOT, 'db', 'migrations', '001_init.sql'), 'utf8');
  assert.match(sql, /"?simulatedPositionSize"? >= 5 AND "?simulatedPositionSize"? <= 20/);
});

test('secrets are redacted from logs', () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const msg = redact(`error calling https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`);
  assert.ok(!msg.includes('AAAAAAAAAA'), 'token leaked into log output');
  delete process.env.TELEGRAM_BOT_TOKEN;
  const pk = redact('leaked 0x' + 'ab'.repeat(32));
  assert.ok(!pk.includes('abababab'), 'private-key shaped hex not redacted');
});
