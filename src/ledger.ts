/**
 * In-memory ledger of what this MCP server process has paid, and the two cumulative caps enforced before signing:
 * X420_MCP_MAX_TOTAL_USD (lifetime of the process) and X420_MCP_MAX_DAILY_USD (rolling 24 hours). The per-call cap
 * (X420_MCP_MAX_USD) lives in pay.ts/server.ts; this ledger only knows totals. Amounts are kept in cents-rounded USD.
 */
export const MAX_TOTAL_ENV = "X420_MCP_MAX_TOTAL_USD";
export const MAX_DAILY_ENV = "X420_MCP_MAX_DAILY_USD";
export const DEFAULT_MAX_TOTAL_USD = 5;
export const DEFAULT_MAX_DAILY_USD = 5;
export const DAY_MS = 86_400_000;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface SpendEntry { ts: string; service: string; amount_usd: number; transaction: string | null }
export interface SpendCaps { maxTotalUsd: number; maxDailyUsd: number }
export interface CapRefusal { cap: typeof MAX_TOTAL_ENV | typeof MAX_DAILY_ENV; window: "lifetime" | "rolling 24h"; limit: number; spent: number; would_be: number }

export class SpendLedger {
  private readonly entries: SpendEntry[] = [];
  constructor(readonly caps: SpendCaps, private readonly now: () => number = Date.now) {}

  count(): number { return this.entries.length; }
  totalUsd(): number { return round2(this.entries.reduce((a, e) => a + e.amount_usd, 0)); }
  dailyUsd(): number {
    const since = this.now() - DAY_MS;
    return round2(this.entries.filter((e) => Date.parse(e.ts) > since).reduce((a, e) => a + e.amount_usd, 0));
  }
  list(): SpendEntry[] { return [...this.entries]; }

  /** Would paying `amountUsd` now break a cumulative cap? The first cap that blocks, or null. */
  check(amountUsd: number): CapRefusal | null {
    const total = this.totalUsd();
    const wouldTotal = round2(total + amountUsd);
    if (wouldTotal > this.caps.maxTotalUsd + 1e-9) return { cap: MAX_TOTAL_ENV, window: "lifetime", limit: this.caps.maxTotalUsd, spent: total, would_be: wouldTotal };
    const daily = this.dailyUsd();
    const wouldDaily = round2(daily + amountUsd);
    if (wouldDaily > this.caps.maxDailyUsd + 1e-9) return { cap: MAX_DAILY_ENV, window: "rolling 24h", limit: this.caps.maxDailyUsd, spent: daily, would_be: wouldDaily };
    return null;
  }

  record(e: { service: string; amount_usd: number; transaction: string | null }): SpendEntry {
    const entry: SpendEntry = { ts: new Date(this.now()).toISOString(), service: e.service, amount_usd: round2(e.amount_usd), transaction: e.transaction };
    this.entries.push(entry);
    return entry;
  }

  summary(perCallUsd: number) {
    const total = this.totalUsd(), daily = this.dailyUsd();
    return {
      calls: this.count(),
      total_usd: total,
      last_24h_usd: daily,
      caps: { per_call_usd: perCallUsd, total_usd: this.caps.maxTotalUsd, daily_usd: this.caps.maxDailyUsd },
      remaining: { total_usd: round2(Math.max(0, this.caps.maxTotalUsd - total)), daily_usd: round2(Math.max(0, this.caps.maxDailyUsd - daily)) },
      entries: this.list(),
    };
  }
}

export function capRefusalMessage(r: CapRefusal, amountUsd: number, service: string, calls: number): string {
  return `refused by ${r.cap}=$${r.limit.toFixed(2)}: paying $${amountUsd.toFixed(2)} for ${service} would bring ${r.window} spend to $${r.would_be.toFixed(2)} (spent $${r.spent.toFixed(2)} across ${calls} paid call${calls === 1 ? "" : "s"} so far). Raise ${r.cap} in the MCP server's environment and restart only if you mean to spend more.`;
}
