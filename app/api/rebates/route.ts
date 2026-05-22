import { NextRequest, NextResponse } from "next/server";
import { fetchTakerTrades, fetchMarketsByConditionIds, tagsForMarket, type RawTrade } from "@/lib/polymarket";
import { categoryFromTags, CATEGORY_WEIGHT, type Category } from "@/lib/categories";
import { progressToNext } from "@/lib/tiers";

export const runtime = "nodejs";
export const revalidate = 60;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface EnrichedTrade {
  timestamp: number;
  side: "BUY" | "SELL";
  title: string;
  slug: string;
  eventSlug: string;
  outcome: string;
  conditionId: string;
  shares: number;
  price: number;
  tradeSizeUsd: number;
  category: Category;
  weight: number;
  wV: number;
  txHash: string;
}

export interface RebateResponse {
  address: string;
  windowStart: number;
  windowEnd: number;
  totalTrades: number;
  totalNotionalUsd: number;
  totalWeightedVolume: number;
  tier: ReturnType<typeof progressToNext>;
  byCategory: Array<{ category: Category; weight: number; wV: number; trades: number }>;
  recentTrades: EnrichedTrade[];
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address || !ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: "Invalid wallet address. Expected 0x-prefixed 40-hex string." }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - 30 * 24 * 60 * 60;

  let trades: RawTrade[];
  try {
    trades = await fetchTakerTrades(address, windowStart);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Polymarket fetch failed: ${msg}` }, { status: 502 });
  }

  const conditionIds = trades.map((t) => t.conditionId).filter(Boolean);
  const markets = await fetchMarketsByConditionIds(conditionIds);

  const enriched: EnrichedTrade[] = trades.map((t) => {
    const tags = tagsForMarket(markets.get(t.conditionId));
    const category = categoryFromTags(tags);
    const weight = CATEGORY_WEIGHT[category];
    const tradeSizeUsd = t.size * t.price;
    const wV = tradeSizeUsd * (1 - t.price) * weight;
    return {
      timestamp: t.timestamp,
      side: t.side,
      title: t.title,
      slug: t.slug,
      eventSlug: t.eventSlug,
      outcome: t.outcome,
      conditionId: t.conditionId,
      shares: t.size,
      price: t.price,
      tradeSizeUsd,
      category,
      weight,
      wV,
      txHash: t.transactionHash,
    };
  });

  const totalWeightedVolume = enriched.reduce((s, x) => s + x.wV, 0);
  const totalNotionalUsd = enriched.reduce((s, x) => s + x.tradeSizeUsd, 0);

  const categoryMap = new Map<Category, { wV: number; trades: number; weight: number }>();
  for (const t of enriched) {
    const prev = categoryMap.get(t.category) ?? { wV: 0, trades: 0, weight: t.weight };
    prev.wV += t.wV;
    prev.trades += 1;
    categoryMap.set(t.category, prev);
  }
  const byCategory = Array.from(categoryMap.entries())
    .map(([category, v]) => ({ category, weight: v.weight, wV: v.wV, trades: v.trades }))
    .sort((a, b) => b.wV - a.wV);

  const recentTrades = enriched.slice().sort((a, b) => b.timestamp - a.timestamp).slice(0, 25);

  const payload: RebateResponse = {
    address,
    windowStart,
    windowEnd: now,
    totalTrades: enriched.length,
    totalNotionalUsd,
    totalWeightedVolume,
    tier: progressToNext(totalWeightedVolume),
    byCategory,
    recentTrades,
  };

  return NextResponse.json(payload);
}
