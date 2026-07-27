/**
 * secrets.test.ts — Phase 0 credential scan
 *
 * Walks the ENTIRE repository tree (including .github/) and fails loudly
 * on any pattern that looks like a hardcoded credential.
 *
 * Must stay clean across ALL phases. Run it in CI.
 *
 * Foundation v2 §2.4: "The test is not optional. It is the proof."
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

/** Files/directories to skip (binary, lockfiles, test expectations, etc.) */
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist', 'build', 'coverage']);
/**
 * Files to skip entirely. .env is gitignored so it's never committed,
 * but we skip it here so the scan focuses on what goes into git.
 */
const SKIP_FILES = new Set(['.env']);
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.woff', '.woff2',
  '.ttf', '.otf', '.eot', '.pdf', '.zip', '.gz', '.tar',
]);

/** Patterns that indicate a hardcoded secret. */
interface Rule {
  name: string;
  re: RegExp;
  /** If true, the line must ALSO match this to trigger (avoids false positives in comments). */
  mustNotMatch?: RegExp;
}

const RULES: Rule[] = [
  {
    name: 'postgres-password-in-url',
    re: /postgresql:\/\/[^:]+:[^@]{8,}@/i,
    // Ignore obvious placeholders
    mustNotMatch: /YOUR_PASSWORD|<password>|\$\{|%s|PLACEHOLDER|example\.com/i,
  },
  {
    name: 'telegram-bot-token',
    re: /\b[0-9]{8,12}:AA[A-Za-z0-9_-]{33,}\b/,
  },
  {
    name: 'github-pat-classic',
    re: /\bghp_[A-Za-z0-9]{36}\b/,
  },
  {
    name: 'github-fine-grained-pat',
    re: /\bgithub_pat_[A-Za-z0-9_]{82}\b/,
  },
  {
    name: 'github-oauth-token',
    re: /\bgho_[A-Za-z0-9]{36}\b/,
  },
  {
    name: 'github-actions-token',
    re: /\bghs_[A-Za-z0-9]{36}\b/,
  },
  {
    name: 'secret-fallback-antipattern',
    // secrets.X || 'value'  or  secrets.X || "value"
    re: /\$\{\{\s*secrets\.[A-Z_]+\s*\}\}\s*\|\|/,
  },
  {
    name: 'FALLBACK_-constant',
    re: /\bFALLBACK_TOKEN\b|\bFALLBACK_CHAT\b|\bFALLBACK_BOT\b/,
  },
  {
    name: 'aws-access-key-id',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
];

/** Recursively collect text files under root. */
function collectFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try { stat = statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (stat.isFile()) {
      const ext = entry.slice(entry.lastIndexOf('.')).toLowerCase();
      if (!SKIP_EXTENSIONS.has(ext)) results.push(full);
    }
  }
  return results;
}

test('credential scan — no hardcoded secrets anywhere in the repo', () => {
  const files = collectFiles(ROOT);
  const findings: string[] = [];

  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, 'utf8'); } catch { continue; }

    const relPath = relative(ROOT, file);
    // Skip this file itself (it contains the pattern strings for testing)
    if (relPath === 'tests/secrets.test.ts') continue;
    // Skip the rotation runbook (documents what to look for)
    if (relPath.startsWith('docs/00-ROTATE-SECRETS')) continue;
    // Skip .env files — they are gitignored and never committed
    if (SKIP_FILES.has(file.split('/').pop() ?? '')) continue;
    // Skip safety.test.ts placeholder token (not a real credential — format is 123456789:AAA...)
    if (relPath === 'tests/safety.test.ts') continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const rule of RULES) {
        if (rule.re.test(line)) {
          if (rule.mustNotMatch && rule.mustNotMatch.test(line)) continue;
          findings.push(
            `[${rule.name}] ${relative(ROOT, file)}:${i + 1}\n  ${line.trim().slice(0, 120)}`
          );
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error('\n\n🔴 CREDENTIAL SCAN FAILED — hardcoded secrets found:\n');
    for (const f of findings) console.error(' ', f);
    console.error(`\nTotal: ${findings.length} finding(s)\n`);
  }

  assert.deepEqual(findings, [], `${findings.length} credential finding(s) — see output above`);
  console.log(`✅ Credential scan clean — ${files.length} files checked`);
});
