import { NextRequest, NextResponse } from "next/server";
import { fetchAllTakerTrades, fetchMarketsByConditionIds, tagsForMarket } from "@/lib/polymarket";
import { categoryFromTags, CATEGORY_FEE_RATE, type Category } from "@/lib/categories";
import { TIERS } from "@/lib/tiers";

export const runtime = "nodejs";
export const revalidate = 60;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// When taker fees went live on Polymarket, per category.
// Trades before these dates paid $0 in fees regardless of category.
const FEE_START_DATE_SEC: Record<Category, number> = {
  Crypto:      Math.floor(new Date("2026-01-05T00:00:00Z").getTime() / 1000),
  Sports:      Math.floor(new Date("2026-02-18T00:00:00Z").getTime() / 1000),
  Politics:    Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Finance:     Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Mentions:    Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Tech:        Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Economics:   Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Culture:     Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Weather:     Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Other:       Math.floor(new Date("2026-03-30T00:00:00Z").getTime() / 1000),
  Geopolitics: Number.MAX_SAFE_INTEGER,
};

export interface FeesResponse {
  address: string;
  totalTrades: number;
  totalFeesPaid: number;
  totalFeeVolume: number;
  avgFee: number;
  effectiveFeeRate: number;
  truncated: boolean;
  feePayingTrades: number;
  byCategory: Array<{ category: Category; fees: number; volume: number; trades: number; rate: number }>;
  potentialRebates: Array<{ tierId: number; name: string; hex: string; rebate: number; refund: number }>;
  dailySeries: Array<{ date: string; fees: number; trades: number }>;
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address")?.trim();
  if (!address || !ADDRESS_RE.test(address)) {
    return NextResponse.json({ error: "Invalid wallet address. Expected 0x-prefixed 40-hex string." }, { status: 400 });
  }

  let trades, truncated;
  try {
    ({ trades, truncated } = await fetchAllTakerTrades(address));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Polymarket fetch failed: ${msg}` }, { status: 502 });
  }

  const conditionIds = trades.map((t) => t.conditionId).filter(Boolean);
  const markets = await fetchMarketsByConditionIds(conditionIds);

  let totalFeesPaid = 0;
  let totalFeeVolume = 0;
  let feePayingTrades = 0;
  const categoryAgg = new Map<Category, { fees: number; volume: number; trades: number; rate: number }>();
  const dailyMap = new Map<string, { fees: number; trades: number }>();
  const nowSec = Math.floor(Date.now() / 1000);
  const thirtyDaysAgo = nowSec - 30 * 24 * 60 * 60;

  for (const t of trades) {
    const market = markets.get(t.conditionId);
    const tags = tagsForMarket(market);
    const category = categoryFromTags(tags);
    const notional = t.size * t.price;

    // Determine actual fee paid. Priority:
    //   1. fee_rate_bps on the trade itself (most accurate, post-rollout)
    //   2. feesEnabled=true AND timestamp >= category fee-start date
    //   3. Otherwise: zero fee
    let feeRate = 0;
    const reportedBps = t.fee_rate_bps == null ? null : Number(t.fee_rate_bps);
    if (reportedBps != null && !Number.isNaN(reportedBps) && reportedBps > 0) {
      feeRate = reportedBps / 10000;
    } else if (
      market?.feesEnabled === true &&
      t.timestamp >= FEE_START_DATE_SEC[category] &&
      CATEGORY_FEE_RATE[category] > 0
    ) {
      feeRate = CATEGORY_FEE_RATE[category];
    }

    const fee = t.size * feeRate * t.price * (1 - t.price);
    if (fee > 0) {
      totalFeesPaid += fee;
      totalFeeVolume += notional;
      feePayingTrades += 1;
    }

    const c = categoryAgg.get(category) ?? { fees: 0, volume: 0, trades: 0, rate: CATEGORY_FEE_RATE[category] };
    c.fees += fee;
    c.volume += notional;
    c.trades += 1;
    categoryAgg.set(category, c);

    if (t.timestamp >= thirtyDaysAgo) {
      const date = new Date(t.timestamp * 1000).toISOString().slice(0, 10);
      const d = dailyMap.get(date) ?? { fees: 0, trades: 0 };
      d.fees += fee;
      d.trades += 1;
      dailyMap.set(date, d);
    }
  }

  const dailySeries: FeesResponse["dailySeries"] = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date((nowSec - i * 86400) * 1000).toISOString().slice(0, 10);
    const v = dailyMap.get(day);
    dailySeries.push({ date: day, fees: v?.fees ?? 0, trades: v?.trades ?? 0 });
  }

  const byCategory = Array.from(categoryAgg.entries())
    .map(([category, v]) => ({ category, ...v }))
    .sort((a, b) => b.fees - a.fees);

  const potentialRebates = TIERS.filter((t) => t.id > 0).map((t) => ({
    tierId: t.id,
    name: t.name,
    hex: t.hex,
    rebate: t.rebate,
    refund: totalFeesPaid * t.rebate,
  }));

  const payload: FeesResponse = {
    address,
    totalTrades: trades.length,
    totalFeesPaid,
    totalFeeVolume,
    avgFee: feePayingTrades > 0 ? totalFeesPaid / feePayingTrades : 0,
    effectiveFeeRate: totalFeeVolume > 0 ? totalFeesPaid / totalFeeVolume : 0,
    truncated,
    feePayingTrades,
    byCategory,
    potentialRebates,
    dailySeries,
  };

  return NextResponse.json(payload);
}
