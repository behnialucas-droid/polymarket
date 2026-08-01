/** Emits the preregistered trial metrics table (JSON + text).
 * Measurement only: this report never claims profitability. With few resolved
 * trades the honest preregistered conclusion is "insufficient evidence". */
import { getDb } from '../src/lib/db.ts';
import { evaluateTrial } from '../src/lib/research/evaluation.ts';

const SEED = Number(process.env.TRIAL_SEED ?? 20260801);
const WINDOW_DAYS = Number(process.env.TRIAL_WINDOW_DAYS ?? 30);

const db = getDb();
try {
  const result = await evaluateTrial(db, { seed: SEED, windowDays: WINDOW_DAYS });
  console.log(JSON.stringify(result, null, 2));

  const arm = (name: string, a: typeof result.hermes) => {
    const ci = a.bootstrap
      ? `95% CI [${a.bootstrap.ciLow.toFixed(2)}, ${a.bootstrap.ciHigh.toFixed(2)}], P(loss)=${a.bootstrap.probabilityOfLoss.toFixed(3)}`
      : 'insufficient data for bootstrap';
    return `${name.padEnd(22)} trades=${a.trades} net=$${a.totalNetPnl.toFixed(2)} winRate=${(a.winRate * 100).toFixed(1)}% maxDD=$${a.maxDrawdown.toFixed(2)} ${ci}`;
  };
  console.log('\n=== Preregistered trial summary (measurement, not a promise) ===');
  console.log(`window=${result.windowDays}d seed=${result.seed} versions: rules=${result.versions.rules} cost=${result.versions.costModel} risk=${result.versions.riskLimit}`);
  console.log(arm('hermes (signed book)', result.hermes));
  console.log(arm('blind copy benchmark', result.blindCopy));
  console.log(arm('skipped counterfactual', result.skippedCounterfactual));
  console.log(`unresolved exposure: ${result.unresolved.positions} positions, $${result.unresolved.reservedCollateral} reserved (excluded from all arms)`);
  const f = result.admissionFunnel;
  console.log(`funnel: observed=${f.observed} scored=${f.scored} paper_copy=${f.paperCopy} admitted=${f.admitted} opened=${f.opened} settled=${f.settled}`);
  if (result.hermes.trades < 30) {
    console.log('CONCLUSION GATE: fewer than 30 settled trades — preregistered conclusion is "insufficient evidence".');
  }
} catch (e: any) {
  console.error('TRIAL REPORT FAILED:', e.message ?? e);
  process.exitCode = 1;
} finally {
  await db.end({ timeout: 5 }).catch(() => {});
}
