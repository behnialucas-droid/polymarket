/**
 * Maintenance script: Reset signed paper account equity to exactly 10000 USD.
 * Records audit event BASELINE_RESET in SignedPaperLedgerEntry.
 * Fails closed if any open positions or lots exist.
 */
import { getDb } from '../src/lib/db.ts';
import { getSignedPaperAccount, resetSignedPaperAccountEquity } from '../src/lib/engine/signedPaperLedgerDb.ts';
import { getSignedAccountSummary } from '../src/lib/readModel.ts';

export async function resetEquity(isDemo = false, targetEquity = 10000): Promise<{
  accountId: number;
  priorStartingCash: number;
  newStartingCash: number;
  summary: any;
}> {
  const db = getDb();
  const res = await resetSignedPaperAccountEquity(db, isDemo, targetEquity, 'Signed paper equity reset to 10000 USD');
  const summary = await getSignedAccountSummary(db, isDemo);

  console.log(`Equity Reset Complete:`);
  console.log(`  - Account ID: ${res.accountId}`);
  console.log(`  - Prior Starting Cash: $${res.priorStartingCash.toFixed(2)}`);
  console.log(`  - New Starting Cash: $${res.newStartingCash.toFixed(2)}`);
  console.log(`  - Available Collateral: $${summary.availableCollateral.toFixed(2)}`);

  return {
    ...res,
    summary,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const db = getDb();
  try {
    const res = await resetEquity(false, 10000);
    console.log(`Successfully reset account ${res.accountId} equity to $${res.newStartingCash.toFixed(2)}.`);
    process.exit(0);
  } catch (err: any) {
    console.error('Equity reset failed:', err.message || err);
    process.exit(1);
  } finally {
    await db.end({ timeout: 5 });
  }
}
