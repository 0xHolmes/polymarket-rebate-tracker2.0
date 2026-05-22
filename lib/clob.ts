// CLOB endpoint client — fetches per-market fee rates.
// This is the authoritative source Polymarket uses at match time.

const CLOB_API = "https://clob.polymarket.com";

// In-memory cache keyed by token_id. Fee rates are fixed per market.
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
    // IMPORTANT: the response field is `base_fee` (in basis points),
    // NOT `fee_rate_bps` as some docs pages suggest. Verified against
    // production: GET /fee-rate?token_id=... → {"base_fee": 1000}
    // We also accept fee_rate_bps as a fallback for safety.
    const json = (await res.json()) as { base_fee?: number | string; fee_rate_bps?: number | string };
    const raw = json?.base_fee ?? json?.fee_rate_bps ?? 0;
    const bps = Number(raw);
    const safe = Number.isFinite(bps) && bps >= 0 ? bps : 0;
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
