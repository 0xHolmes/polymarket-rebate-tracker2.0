// Thin client around Polymarket's public Data API and Gamma API.
//
//   Data API : https://data-api.polymarket.com  (trades, positions, activity)
//   Gamma API: https://gamma-api.polymarket.com (markets, events, tags)

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

export interface RawTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  title: string;
  slug: string;
  icon: string;
  eventSlug: string;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  // Present on post-fee-rollout trades. Basis points; absent => 0.
  fee_rate_bps?: string | number;
}

export interface GammaMarketLite {
  conditionId: string;
  slug: string;
  question: string;
  // Authoritative signal: if false, this market has never charged fees.
  feesEnabled?: boolean;
  events?: Array<{
    slug: string;
    title: string;
    tags?: Array<{ label: string; slug: string }>;
  }>;
  tags?: Array<{ label: string; slug: string }>;
}

export async function fetchTakerTrades(
  address: string,
  sinceTimestamp: number,
  maxPages = 50,
): Promise<RawTrade[]> {
  const trades: RawTrade[] = [];
  const limit = 500;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${DATA_API}/trades`);
    url.searchParams.set("user", address);
    url.searchParams.set("takerOnly", "true");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(page * limit));

    const res = await fetch(url.toString(), { next: { revalidate: 60 } });
    if (!res.ok) {
      throw new Error(`Polymarket trades API ${res.status}: ${await res.text()}`);
    }

    const batch = (await res.json()) as RawTrade[];
    if (!Array.isArray(batch) || batch.length === 0) break;

    let crossedWindow = false;
    for (const t of batch) {
      if (t.timestamp < sinceTimestamp) {
        crossedWindow = true;
        break;
      }
      trades.push(t);
    }

    if (crossedWindow || batch.length < limit) break;
  }

  return trades;
}

export async function fetchAllTakerTrades(
  address: string,
  maxPages = 100,
): Promise<{ trades: RawTrade[]; truncated: boolean }> {
  const trades: RawTrade[] = [];
  const limit = 500;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${DATA_API}/trades`);
    url.searchParams.set("user", address);
    url.searchParams.set("takerOnly", "true");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(page * limit));

    const res = await fetch(url.toString(), { next: { revalidate: 60 } });
    if (!res.ok) {
      throw new Error(`Polymarket trades API ${res.status}: ${await res.text()}`);
    }

    const batch = (await res.json()) as RawTrade[];
    if (!Array.isArray(batch) || batch.length === 0) break;
    trades.push(...batch);

    if (batch.length < limit) break;
    if (page === maxPages - 1 && batch.length === limit) truncated = true;
  }

  return { trades, truncated };
}

export async function fetchMarketsByConditionIds(
  conditionIds: string[],
): Promise<Map<string, GammaMarketLite>> {
  const out = new Map<string, GammaMarketLite>();
  const unique = Array.from(new Set(conditionIds));
  const chunkSize = 20;

  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const url = new URL(`${GAMMA_API}/markets`);
    for (const id of chunk) url.searchParams.append("condition_ids", id);
    url.searchParams.set("limit", String(chunkSize));

    const res = await fetch(url.toString(), { next: { revalidate: 3600 } });
    if (!res.ok) continue;

    const json = (await res.json()) as GammaMarketLite[];
    if (!Array.isArray(json)) continue;

    for (const m of json) {
      if (m.conditionId) out.set(m.conditionId, m);
    }
  }

  return out;
}

export function tagsForMarket(m: GammaMarketLite | undefined): string[] {
  if (!m) return [];
  const labels = new Set<string>();
  for (const t of m.tags ?? []) labels.add(t.label);
  for (const e of m.events ?? []) {
    for (const t of e.tags ?? []) labels.add(t.label);
  }
  return Array.from(labels);
}
