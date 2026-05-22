import { NextRequest, NextResponse } from "next/server";
import { fetchAllTakerTrades, fetchMarketsByConditionIds, tagsForMarket } from "@/lib/polymarket";
import { fetchFeeRatesForTokens } from "@/lib/clob";
import { categoryFromTags, type Category } from "@/lib/categories";
import { TIERS } from "@/lib/tiers";

export const runtime = "nodejs";
export const revalidate = 60;
export const maxDuration = 60;

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

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

  // Pull in parallel: market metadata (for category labels) AND per-token
  // fee rates (the authoritative source matching what Polymarket charges).
  const conditionIds = trades.map((t) => t.conditionId).filter(Boolean);
  const tokenIds = trades.map((t) => t.asset).filter(Boolean);
  const [markets, feeRates] = await Promise.all([
    fetchMarketsByConditionIds(conditionIds),
    fetchFeeRatesForTokens(tokenIds),
  ]);

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

    // Authoritative fee rate. Priority:
    //   1. fee_rate_bps emitted on the trade itself (cleanest)
    //   2. Per-token rate from CLOB /fee-rate endpoint
    //   3. Zero
    let feeRateBps = 0;
    const reportedBps = t.fee_rate_bps == null ? 0 : Number(t.fee_rate_bps);
    if (reportedBps > 0 && Number.isFinite(reportedBps)) {
      feeRateBps = reportedBps;
    } else {
      feeRateBps = feeRates.get(t.asset) ?? 0;
    }
    const feeRate = feeRateBps / 10000;

    const fee = t.size * feeRate * t.price * (1 - t.price);
    if (fee > 0) {
      totalFeesPaid += fee;
      totalFeeVolume += notional;
      feePayingTrades += 1;
    }

    const c = categoryAgg.get(category) ?? { fees: 0, volume: 0, trades: 0, rate: feeRate };
    c.fees += fee;
    c.volume += notional;
    c.trades += 1;
    if (feeRate > c.rate) c.rate = feeRate;
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
