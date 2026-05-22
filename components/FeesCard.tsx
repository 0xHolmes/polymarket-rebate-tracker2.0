import type { FeesResponse } from "@/app/api/fees/route";

interface Props {
  data: FeesResponse;
  currentTierId: number;
}

const fmtUsd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(1)}K` : `$${n.toFixed(2)}`;

const fmtUsdExact = (n: number) =>
  n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-1">{label}</p>
      <p className="font-mono text-xl tnum font-light text-zinc-100">{value}</p>
      {sub && <p className="text-[10px] text-zinc-600 mt-0.5">{sub}</p>}
    </div>
  );
}

function Sparkline({ data }: { data: FeesResponse["dailySeries"] }) {
  const max = Math.max(...data.map((d) => d.fees), 0.0001);
  const width = 400;
  const height = 40;
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((d, i) => {
    const x = i * step;
    const y = height - (d.fees / max) * height;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const pathLine = `M ${points.join(" L ")}`;
  const pathArea = `M 0,${height} L ${points.join(" L ")} L ${width},${height} Z`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-10">
      <defs>
        <linearGradient id="sparkfill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#165DFC" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#165DFC" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={pathArea} fill="url(#sparkfill)" />
      <path d={pathLine} fill="none" stroke="#165DFC" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function FeesCard({ data, currentTierId }: Props) {
  const hasFees = data.totalFeesPaid > 0;

  return (
    <div className="relative overflow-hidden rounded-2xl bg-ink-800 border border-ink-600">
      <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-accent to-transparent opacity-40" />

      <div className="p-8">
        <div className="flex items-baseline justify-between mb-6">
          <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Fees Receipt</p>
          <p className="text-xs text-zinc-600 font-mono">All time{data.truncated ? " · 50k+ trades, truncated" : ""}</p>
        </div>

        <div className="flex items-baseline justify-between flex-wrap gap-6 mb-8">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">Total fees paid</p>
            <p className="font-display text-6xl sm:text-7xl font-light leading-none text-zinc-100">{fmtUsdExact(data.totalFeesPaid)}</p>
            <p className="text-zinc-500 text-sm mt-3 font-mono">across {data.totalTrades.toLocaleString()} taker trades</p>
          </div>

          {hasFees && (
            <div className="min-w-[200px] flex-1 max-w-md">
              <p className="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-2">Daily fees · last 30d</p>
              <Sparkline data={data.dailySeries} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-6 pb-8 border-b border-ink-600">
          <MiniStat label="Fee volume" value={fmtUsd(data.totalFeeVolume)} sub="excl. free markets" />
          <MiniStat label="Avg fee / trade" value={fmtUsdExact(data.avgFee)} />
          <MiniStat label="Effective rate" value={`${(data.effectiveFeeRate * 100).toFixed(2)}%`} sub="paid / volume" />
          <MiniStat label="Top category" value={data.byCategory[0]?.category ?? "—"} sub={data.byCategory[0] ? fmtUsd(data.byCategory[0].fees) : ""} />
        </div>

        {hasFees && (
          <div className="pt-8">
            <div className="flex items-baseline justify-between mb-5">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-400">What you would have gotten back</p>
              <p className="text-[10px] text-zinc-600 font-mono">if held this tier all-time</p>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
              {data.potentialRebates.map((r) => {
                const active = r.tierId === currentTierId;
                return (
                  <div key={r.tierId} className={`rounded-lg p-3 border transition-colors ${active ? "border-current" : "border-ink-600 bg-ink-700/40"}`} style={active ? { borderColor: r.hex, background: `${r.hex}10` } : undefined}>
                    <p className="text-[10px] uppercase tracking-wider font-medium" style={{ color: r.hex }}>{r.name}</p>
                    <p className="text-[10px] text-zinc-600 font-mono">{(r.rebate * 100).toFixed(0)}%</p>
                    <p className="font-mono tnum text-lg mt-1.5 text-zinc-100">{fmtUsdExact(r.refund)}</p>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-zinc-600 mt-4 leading-relaxed">Note: this is a retroactive estimate. Real rebates only apply going forward from the moment you reach a tier.</p>
          </div>
        )}
      </div>
    </div>
  );
}
