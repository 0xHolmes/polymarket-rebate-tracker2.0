// CLOB endpoint client — fetches per-market fee rates.
// This is the same source Polymarket uses to charge fees at match time,
// so it gives exact-cent accuracy matching betmoar.fun / on-chain data.

const CLOB_API = "https://clob.polymarket.com";

// In-memory cache, keyed by token_id (asset). The fee rate for a given
// token is fixed for the market's lifetime, so caching is safe.
const feeRateCache = new Map<string, number>();

async function fetchFeeRateBps(tokenId: string): Promise<number> {
  if (feeRateCache.has(tokenId)) return feeRateCache.get(tokenId)!;

  try {
    const res = await fetch(`${CLOB_API}/fee-rate?token_id=${tokenId}`, {
      next: { revalidate: 86400 },
    });
    if (!res.ok) {
      feeRateCache.set(tokenId, 0);
      return 0;
    }
    const json = (await res.json()) as { fee_rate_bps?: number | string };
    const bps = Number(json?.fee_rate_bps ?? 0);
    const safe = Number.isFinite(bps) ? bps : 0;
    feeRateCache.set(tokenId, safe);
    return safe;
  } catch {
    feeRateCache.set(tokenId, 0);
    return 0;
  }
}

export async function fetchFeeRatesForTokens(tokenIds: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(tokenIds.filter(Boolean)));
  const out = new Map<string, number>();
  const CONCURRENCY = 12;

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(
      (async () => {
        while (cursor < unique.length) {
          const myIdx = cursor++;
          const tokenId = unique[myIdx];
          const bps = await fetchFeeRateBps(tokenId);
          out.set(tokenId, bps);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return out;
}
