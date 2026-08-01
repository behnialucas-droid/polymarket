# TASK-04 — Five `catch` blocks swallow real API errors

## Problem

The project contract says: *if any API fails, show the real error and stop; never fake data.*
Five places do the opposite.

| Location | Code | What it hides |
|---|---|---|
| `src/lib/adapters/polymarket.ts` ~line 48 | `} catch { break; }` | A 500 on leaderboard page 3 returns a truncated list that the caller cannot distinguish from a complete one. `runLeaderboardScan` then writes that count into `LeaderboardScan.walletCount` as fact. |
| `scripts/pipeline.ts` ~line 133 | `} catch { return; }` | Wallet fetch failure is indistinguishable from "wallet had no new trades". |
| `scripts/pipeline.ts` ~line 146 | `} catch { continue; }` | Market fetch failure is indistinguishable from "market archived". |
| `scripts/pipeline.ts` ~line 186 | `} catch { /* Ignore constraint/duplicate error on concurrent inserts */ }` | Genuine write failures are counted as duplicates, so `newCount` under-reports with no signal. |
| `scripts/pipeline.ts` ~line 214 | `catch { continue; }` in `scoreNewTrades` | Same as above for the scoring pass. |

`AdapterError` already declares `status` and `body`, but the only construction site passes
neither, so both are always `undefined`.

## Design

Do **not** convert these to hard crashes. A single archived market must not kill a 500-wallet
cycle. The requirement is *visibility*, not fragility:

1. Every swallowed error gets logged with the real message, through `redact()`.
2. Every batch job counts its failures and reports them in its return value.
3. Leaderboard pagination is the one exception — a partial leaderboard is corrupt data, not a
   degraded result, so it **throws**.

## Files to change

1. `/home/nima/.../runtime/src/lib/adapters/polymarket.ts` — **MIRRORED** to `dashboard/src/lib/adapters/polymarket.ts`
2. `/home/nima/.../runtime/scripts/pipeline.ts` — not mirrored

## Edit 1 — leaderboard must not silently truncate

BEFORE (must match exactly):
```ts
      } catch {
        break;
      }
```

AFTER:
```ts
      } catch (e: unknown) {
        // A partial leaderboard is corrupt data, not a degraded result: the caller records
        // the length as the real wallet count. Fail rather than lie about the universe size.
        throw new AdapterError(
          `leaderboard page at offset ${offset} failed after ${out.length} entries: ${(e as Error)?.message ?? String(e)}`,
        );
      }
```

## Edit 2 — wallet fetch failures are visible and counted

In `monitorTrades`, BEFORE (must match exactly):
```ts
        let trades: any[];
        try {
          trades = await adapter.fetchWalletTrades(w.address, since);
        } catch {
          return;
        }
```

AFTER:
```ts
        let trades: any[];
        try {
          trades = await adapter.fetchWalletTrades(w.address, since);
        } catch (e: unknown) {
          failures.push(`fetchWalletTrades(${w.address}): ${redact((e as Error)?.message ?? e)}`);
          return;
        }
```

## Edit 3 — market fetch failures are visible and counted

BEFORE (must match exactly):
```ts
          let m: any;
          try {
            m = await adapter.fetchMarket(t.marketId);
          } catch {
            continue;
          }
```

AFTER:
```ts
          let m: any;
          try {
            m = await adapter.fetchMarket(t.marketId);
          } catch (e: unknown) {
            failures.push(`fetchMarket(${t.marketId}): ${redact((e as Error)?.message ?? e)}`);
            continue;
          }
```

## Edit 4 — distinguish duplicate inserts from real write errors

BEFORE (must match exactly):
```ts
          } catch {
            // Ignore constraint/duplicate error on concurrent inserts
          }
```

AFTER:
```ts
          } catch (e: unknown) {
            // 23505 = unique_violation, i.e. a concurrent worker inserted the same tradeHash.
            // Anything else is a real write failure and must not be counted as a duplicate.
            const code = (e as { code?: string })?.code;
            if (code !== '23505') {
              failures.push(`insert ObservedTrade(${t.marketId}): ${redact((e as Error)?.message ?? e)}`);
            }
          }
```

## Edit 5 — wire up the failure list

At the top of `monitorTrades`, after `const scanLimit = ...`, add:
```ts
  const failures: string[] = [];
```

At the end of `monitorTrades`, BEFORE:
```ts
  return newCount;
}
```

AFTER:
```ts
  if (failures.length) {
    console.warn(`[monitorTrades] ${failures.length} failures this pass:`);
    for (const f of failures.slice(0, 20)) console.warn('  -', f);
    if (failures.length > 20) console.warn(`  … and ${failures.length - 20} more`);
  }
  return newCount;
}
```

Add the import at the top of `pipeline.ts` if it is not already there:
```ts
import { redact } from '../src/lib/env.ts';
```

Apply the same treatment to the `catch { continue; }` in `scoreNewTrades` — that function has
its own local `failures` array and logs it the same way before returning.

## Hard rules

- Never log a raw error object; always pass it through `redact()`.
- Do not change any HTTP method. Adapters stay GET-only.
- Do not add a retry loop — `http.ts` already retries. You are adding visibility, not resilience.

## Acceptance

- `grep -n "catch {$" scripts/pipeline.ts src/lib/adapters/polymarket.ts` returns nothing.
- No `catch` block in these two files discards its error without either logging or rethrowing.
- `npm test` green; adapter mirror identical.

## Verification

```bash
cd /home/nima/Documents/claude.app/polymarket-repo/hermes-polybot/runtime
grep -n "catch {" scripts/pipeline.ts src/lib/adapters/polymarket.ts
npm test
diff src/lib/adapters/polymarket.ts ../dashboard/src/lib/adapters/polymarket.ts && echo "MIRROR OK"
```

Expected: no bare `catch {` remains; `# fail 0`; `MIRROR OK`.
