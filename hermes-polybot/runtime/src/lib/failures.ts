/**
 * recordFailure — Foundation v2 Phase 3
 *
 * Increments profileAttempts and clears claimedAt for wallets that
 * fail during profiling. This allows the rescan chunk to retry them
 * up to `profileAttempts < 3` times before skipping.
 *
 * Never swallows the error — always records AND rethrows or logs.
 */

import { getDb } from './db.ts';
import { redact } from './env.ts';

/**
 * Record a profiling failure for `address`.
 * Clears claimedAt so the wallet becomes claimable again by the next chunk.
 * Does NOT rethrow — callers handle their own control flow.
 */
export async function recordFailure(
  address: string,
  error: unknown
): Promise<void> {
  const db = getDb();
  const errStr = redact(error).slice(0, 500);

  try {
    await db`
      UPDATE "WalletProfile"
         SET "profileAttempts" = "profileAttempts" + 1,
             "profileError"    = ${errStr},
             "claimedAt"       = NULL
       WHERE "address" = ${address}
    `;
  } catch (dbErr: unknown) {
    // DB error during failure recording — log but don't throw further
    console.error(`recordFailure DB error for ${address}:`, redact(dbErr));
  }
}
