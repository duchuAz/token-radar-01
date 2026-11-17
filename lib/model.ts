// The token radar's model: comps-fitted log multiples, a ranked board, honest validation and costed
// farm plans. One snapshot of the protocol universe in, one ranked board out, standard library only.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// pre-token protocol below the floor that passes the same full rule: the early rows the radar exists to
// find. A protocol records no token when its entry carries no market cap, no CoinGecko id and no symbol;
// the snapshot's live-token protocols are never ranked -- they are the fit sample, the market's own
// verdict on what a protocol's TVL is worth once its token trades.
//
// The model is a comps regression, fitted at build time on the snapshot's own live protocols:
//
//   y  = log10(mcap_usd / tvl_usd)                     (winsorized at the 1st/99th percentiles)
//   x1 = log10(tvl_usd)
//   x2 = clamp(change_7d ?? 0, -60, 120) / 100
//   x3 = log10(1 + (age_days ?? 365) / 365)
//   x4 = min(chains.length, 8) / 8
//
// A robust OLS (normal equations + Gaussian elimination, then 3 Huber IRLS rounds) gives the fitted log
// multiple; a shrunk median residual per category (n / (n + 8), clamped to [-1, 1]) is the partially
// pooled category effect. pred = fitted + category adjustment; multiple = 10^pred clamped to
// [0.02, 8]; implied_value_usd = max(1, round(tvl_usd * multiple)).
//
// Every number the dashboard states is computed here, at build time, from the snapshot: the fit sample,
// the 5-fold cross-validation (stable FNV-1a hash of the slug modulo 5), the out-of-fold MAE and R2 in
// log space, the 80% interval coverage, the Spearman rank IC, the calibration slope, the per-row
// uncertainty from the out-of-fold residual quantiles, and the farm economics.

/** A protocol's entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** A live-token protocol: the fit sample's anchor, shown with the market's own multiple. */
export interface LiveComp {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  multiple: number;
  predicted_multiple: number;
  age_days: number | null;
}

/** The farm plan's economics, stated per row so the page can draw a timeline and a P&L table. */
export interface FarmPlan {
  position_usd: number;
  gas_usd: number;
  bridge_usd: number;
  opportunity_usd: number;
  total_cost_usd: number;
  hold_days: number;
  break_even_pct: number;
  net_10_usd: number;
  net_25_usd: number;
  net_50_usd: number;
  action: string;
}

/** The model's per-row explanation: the five required keys plus the comps evidence. */
export interface RowModel {
  base_multiple: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  age_days: number | null;
  comps_n: number;
  category_adj: number;
  low_usd: number;
  high_usd: number;
}

/** One row of board.json: the ranked board's row, the gate's shape exactly. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: RowModel;
  farm_steps: string[];
}

/** The dashboard's row: the board row's fields plus the farm plan and the range. */
export interface RadarRow extends BoardRow {
  farm: FarmPlan;
  watchlist: boolean;
}

/** One category's aggregate: row count, median multiple, median implied value, comps count. */
export interface CategoryStat {
  category: string;
  n: number;
  comps_n: number;
  median_multiple: number;
  median_implied_usd: number;
  adjustment: number;
}

/** The cross-validation's computed numbers, as the dashboard states them. */
export interface Validation {
  comps_n: number;
  folds: number;
  mae_log10: number;
  r2_log: number;
  coverage_80: number;
  spearman: number;
  calibration_slope: number;
  resid_q10: number;
  resid_q90: number;
}

/** The fitted model as the page names it. */
export interface FitMeta {
  version: string;
  sample_n: number;
  winsor_p1: number;
  winsor_p99: number;
  intercept: number;
  coef: number[];
  feature_names: string[];
  huber_rounds: number;
}

/** Everything the dashboard needs, serialized into data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  universe: { watchlist: number; early: number; below_floor: number; above_floor_extra: number; total: number };
  board_size: number;
  live_size: number;
  median_implied_usd: number;
  fit: FitMeta;
  validation: Validation;
  categories: CategoryStat[];
  comps: LiveComp[];
  rows: RadarRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const UNKNOWN_AGE_DAYS = 365;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when a date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Linear-interpolated quantile of an ascending array; 0 for an empty one. */
function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (pos - lo);
}

/** The ascending copy of an array. */
function ascending(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** FNV-1a over a string's UTF-16 units, unsigned: the folds' stable hash, never Math.random. */
export function fnv1a(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The winsorized log multiple and the model's four features, with the intercept first. */
export function featuresOf(p: SnapshotProtocol, asOf: string): number[] {
  const age = ageDays(asOf, p.listed_at);
  return [
    1,
    Math.log10(p.tvl_usd),
    clamp(finite(p.change_7d, 0), -60, 120) / 100,
    Math.log10(1 + (age ?? UNKNOWN_AGE_DAYS) / 365),
    Math.min(p.chains.length, 8) / 8,
  ];
}

/** Solve A x = b by Gaussian elimination with partial pivoting; throws on a singular matrix. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[pivot]![c]!)) pivot = r;
    if (Math.abs(m[pivot]![c]!) < 1e-12) throw new Error('lib/model: the design matrix is singular');
    const swap = m[c]!;
    m[c] = m[pivot]!;
    m[pivot] = swap;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** Weighted ordinary least squares: the normal equations, then Gaussian elimination. */
function weightedOls(x: number[][], y: number[], w: number[]): number[] {
  const p = x[0]!.length;
  const xtx: number[][] = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const xty = new Array<number>(p).fill(0);
  for (let i = 0; i < x.length; i++) {
    const wi = w[i]!;
    for (let j = 0; j < p; j++) {
      xty[j]! += wi * x[i]![j]! * y[i]!;
      for (let k = 0; k < p; k++) xtx[j]![k]! += wi * x[i]![j]! * x[i]![k]!;
    }
  }
  return solveLinear(xtx, xty);
}
/** One fit's inputs: the design rows, the winsorized targets, and the protocols they came from. */
interface FitInput {
  rows: number[][];
  y: number[];
  cats: string[];
}

/** The Huber IRLS fit: three rounds, delta = 1.5 x the residual MAD, weight min(1, delta/|r|). */
export function huberFit(input: FitInput): { coef: number[]; rounds: number } {
  let coef = weightedOls(input.rows, input.y, input.y.map(() => 1));
  const rounds = 3;
  for (let round = 0; round < rounds; round++) {
    const resid = input.y.map((target, i) => target - dot(input.rows[i]!, coef));
    const med = quantile(ascending(resid), 0.5);
    const mad = quantile(ascending(resid.map((r) => Math.abs(r - med))), 0.5);
    const delta = 1.5 * mad;
    const w = resid.map((r) => (Math.abs(r) < 1e-12 ? 1 : Math.min(1, delta / Math.abs(r))));
    coef = weightedOls(input.rows, input.y, w);
  }
  return { coef, rounds };
}

/** The dot product of a design row and the fitted coefficients. */
function dot(row: number[], coef: number[]): number {
  let sum = 0;
  for (let j = 0; j < row.length; j++) sum += row[j]! * coef[j]!;
  return sum;
}

/** Per-category residuals from a training fit, shrunk n/(n+8) and clamped to [-1, 1]. */
export function categoryAdjustments(cats: string[], residuals: number[]): Map<string, { adj: number; n: number; median: number }> {
  const groups = new Map<string, number[]>();
  for (let i = 0; i < cats.length; i++) {
    const list = groups.get(cats[i]!);
    if (list === undefined) groups.set(cats[i]!, [residuals[i]!]);
    else list.push(residuals[i]!);
  }
  const out = new Map<string, { adj: number; n: number; median: number }>();
  for (const [category, list] of groups) {
    const median = quantile(ascending(list), 0.5);
    const n = list.length;
    out.set(category, { adj: clamp((median * n) / (n + 8), -1, 1), n, median });
  }
  return out;
}

/** The fit sample's protocol is a live comp: token trades, both TVL and market cap above $1M, not a CEX. */
export function isLiveComp(p: SnapshotProtocol): boolean {
  return (
    typeof p.mcap_usd === 'number' &&
    Number.isFinite(p.mcap_usd) &&
    p.mcap_usd > 0 &&
    p.tvl_usd > 0 &&
    p.mcap_usd >= 1_000_000 &&
    p.tvl_usd >= 1_000_000 &&
    p.category !== 'CEX'
  );
}

/** The fit sample, sorted by slug so every build sees the same rows in the same order. */
export function fitSample(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(isLiveComp).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The model version the dashboard names and the README quotes. */
export const MODEL_VERSION = 'comps-1.0';

/** The fitted state the board and the page share: coefficients, winsor bounds and category effects. */
export interface Fitted {
  coef: number[];
  p1: number;
  p99: number;
  adjustments: Map<string, { adj: number; n: number; median: number }>;
}

/** Fit the comps model on a set of live comps: winsor, robust fit, category shrinkage. */
export function fitModel(comps: SnapshotProtocol[], asOf: string): Fitted {
  const raw = comps.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
  const p1 = quantile(ascending(raw), 0.01);
  const p99 = quantile(ascending(raw), 0.99);
  const y = raw.map((v) => clamp(v, p1, p99));
  const rows = comps.map((p) => featuresOf(p, asOf));
  const cats = comps.map((p) => p.category ?? 'null');
  const { coef } = huberFit({ rows, y, cats });
  const fitted = rows.map((row) => dot(row, coef));
  const residuals = y.map((target, i) => target - fitted[i]!);
  return { coef, p1, p99, adjustments: categoryAdjustments(cats, residuals) };
}

/** The predicted log multiple for a protocol under a fitted model, with its category effect. */
export function predictLog(fit: Fitted, p: SnapshotProtocol, asOf: string): { log: number; adj: number; n: number } {
  const cat = p.category ?? 'null';
  const entry = fit.adjustments.get(cat);
  const adj = entry === undefined ? 0 : entry.adj;
  return { log: dot(featuresOf(p, asOf), fit.coef) + adj, adj, n: entry === undefined ? 0 : entry.n };
}

/** Average ranks with ties shared: the Spearman input. */
function ranksOf(values: number[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v || a.i - b.i);
  const out = new Array<number>(values.length).fill(0);
  let at = 0;
  while (at < idx.length) {
    let end = at;
    while (end + 1 < idx.length && idx[end + 1]!.v === idx[at]!.v) end++;
    const rank = (at + end) / 2 + 1;
    for (let k = at; k <= end; k++) out[idx[k]!.i] = rank;
    at = end + 1;
  }
  return out;
}

/** The 5-fold cross-validation: stable folds, training-only category effects, out-of-fold stats. */
export function crossValidate(comps: SnapshotProtocol[], asOf: string, folds = 5): {
  validation: Validation;
  oofResiduals: number[];
  oof: { slug: string; predicted: number; actual: number }[];
  q10: number;
  q90: number;
} {
  const foldOf = comps.map((p) => fnv1a(p.slug) % folds);
  const oof: { slug: string; predicted: number; actual: number; q10: number; q90: number }[] = [];
  for (let fold = 0; fold < folds; fold++) {
    const train = comps.filter((_, i) => foldOf[i] !== fold);
    const test = comps.filter((_, i) => foldOf[i] === fold);
    if (train.length === 0 || test.length === 0) continue;
    const fit = fitModel(train, asOf);
    const trainRaw = train.map((p) => Math.log10(p.mcap_usd! / p.tvl_usd));
    const trainPred = train.map((p) => dot(featuresOf(p, asOf), fit.coef));
    const trainResid = trainRaw.map((raw, i) => raw - trainPred[i]!);
    const q10 = quantile(ascending(trainResid), 0.1);
    const q90 = quantile(ascending(trainResid), 0.9);
    for (const p of test) {
      const { log } = predictLog(fit, p, asOf);
      oof.push({ slug: p.slug, predicted: log, actual: Math.log10(p.mcap_usd! / p.tvl_usd), q10, q90 });
    }
  }
  const errors = oof.map((o) => o.actual - o.predicted);
  const mae = errors.reduce((a, e) => a + Math.abs(e), 0) / Math.max(1, errors.length);
  const meanActual = oof.reduce((a, o) => a + o.actual, 0) / Math.max(1, oof.length);
  const sse = errors.reduce((a, e) => a + e * e, 0);
  const sst = oof.reduce((a, o) => a + (o.actual - meanActual) ** 2, 0);
  const r2 = sst === 0 ? 0 : 1 - sse / sst;
  const coverage = oof.length === 0 ? 0 : oof.filter((o) => o.actual >= o.predicted + o.q10 && o.actual <= o.predicted + o.q90).length / oof.length;
  const predictedRanks = ranksOf(oof.map((o) => o.predicted));
  const actualRanks = ranksOf(oof.map((o) => o.actual));
  const meanPredRank = predictedRanks.reduce((a, v) => a + v, 0) / Math.max(1, predictedRanks.length);
  const meanActRank = actualRanks.reduce((a, v) => a + v, 0) / Math.max(1, actualRanks.length);
  let cov = 0;
  let varP = 0;
  let varA = 0;
  for (let i = 0; i < predictedRanks.length; i++) {
    cov += (predictedRanks[i]! - meanPredRank) * (actualRanks[i]! - meanActRank);
    varP += (predictedRanks[i]! - meanPredRank) ** 2;
    varA += (actualRanks[i]! - meanActRank) ** 2;
  }
  const spearman = varP === 0 || varA === 0 ? 0 : cov / Math.sqrt(varP * varA);
  const meanPred = oof.reduce((a, o) => a + o.predicted, 0) / Math.max(1, oof.length);
  let slopeNum = 0;
  let slopeDen = 0;
  for (const o of oof) {
    slopeNum += (o.predicted - meanPred) * (o.actual - meanActual);
    slopeDen += (o.predicted - meanPred) ** 2;
  }
  const slope = slopeDen === 0 ? 0 : slopeNum / slopeDen;
  const q10 = quantile(ascending(errors), 0.1);
  const q90 = quantile(ascending(errors), 0.9);
  const validation: Validation = {
    comps_n: comps.length,
    folds,
    mae_log10: round(mae, 4),
    r2_log: round(r2, 4),
    coverage_80: round(coverage, 4),
    spearman: round(spearman, 4),
    calibration_slope: round(slope, 4),
    resid_q10: round(q10, 4),
    resid_q90: round(q90, 4),
  };
  return { validation, oofResiduals: errors, oof: oof.map((o) => ({ slug: o.slug, predicted: o.predicted, actual: o.actual })), q10, q90 };
}

/** Round to `places` decimals, deterministically. */
export function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A wrapped or staked product of a token that already trades is not a launch of its own. */
const WRAPPED = /\b(wrapped|staked|staking)\b/i;
/** An exchange's own product, named after the exchange. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;
/** Categories that are somebody else's product, never a launch of their own. */
const BLOCKED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** The full pre-token rule: no token, not a versioned pool, not bridged/staked, not a CEX product. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** The candidate universe: watchlist first (the floor), then every early candidate below the floor. */
export function candidateUniverse(snapshot: Snapshot): {
  watchlist: SnapshotProtocol[];
  aboveFloorExtra: SnapshotProtocol[];
  belowFloor: SnapshotProtocol[];
} {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist: SnapshotProtocol[] = [];
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p === undefined) throw new SnapshotError(`snapshot.json's watchlist names ${slug}, which protocols does not carry`);
    if (!isLaunchCandidate(p)) throw new SnapshotError(`snapshot.json's watchlist names ${slug}, which the full rule excludes`);
    watchlist.push(p);
  }
  const seen = new Set(watchlist.map((p) => p.slug));
  const bySlugAsc = (a: SnapshotProtocol, b: SnapshotProtocol): number => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const rest = snapshot.protocols.filter((p) => !seen.has(p.slug) && isLaunchCandidate(p));
  // At or above the floor but left off the snapshot's watchlist: the watchlist's own rule also excluded
  // parent-protocol products, which this radar's rule admits. They are early rows too, not watchlist rows.
  const aboveFloorExtra = rest.filter((p) => p.tvl_usd >= snapshot.floor_usd).sort(bySlugAsc);
  const belowFloor = rest.filter((p) => p.tvl_usd < snapshot.floor_usd).sort(bySlugAsc);
  return { watchlist, aboveFloorExtra, belowFloor };
}

/** The fee schedule the farm plans quote: illustrative estimates, stated as such on the page. */
export function gasUsd(chains: string[]): number {
  if (chains.length === 0) return 4;
  if (chains.includes('Ethereum')) return 8;
  const cheap = ['Base', 'Arbitrum', 'Optimism', 'Polygon'];
  if (chains.some((c) => cheap.includes(c))) return 3;
  if (chains.includes('Solana')) return 1;
  return 4;
}

/** The position size from TVL, the hold period from age: both stated per row. */
export function positionUsd(tvl: number): number {
  if (tvl < 10_000_000) return 50;
  if (tvl < 50_000_000) return 100;
  if (tvl < 250_000_000) return 250;
  return 500;
}

/** Younger protocols get a longer qualifying window. */
export function holdDays(age: number | null): number {
  if (age === null || age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one concrete action, case-insensitive on the snapshot's own category string. */
export function categoryAction(category: string | null, name: string, capital: number, chain: string): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `supply $${capital} of USDC to ${name} on ${chain} as collateral and borrow no more than 25% of it`;
  if (c.includes('leveraged farm')) return `provide $${capital} of liquidity to ${name}'s main leveraged-farming pool on ${chain}`;
  if (c.includes('dex') || c === 'yield' || c.includes('yield aggregator')) return `provide $${capital} of liquidity to ${name}'s main pool on ${chain}`;
  if (c.includes('bridge')) return `bridge $${capital} of USDC to ${chain} through ${name} and use the app on the destination chain`;
  if (c.includes('staking') || c.includes('restak')) return `stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('basis')) return `deposit $${capital} of USDC margin on ${name} and open one small hedge on ${chain}`;
  if (c.includes('prediction')) return `fund $${capital} on ${name} and place one market position`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager')) return `deposit $${capital} into a ${name} curator vault on ${chain} and keep the shares`;
  if (c.includes('rwa') || c.includes('anchor btc') || c.includes('decentralized btc')) return `mint or deposit $${capital} of ${name}'s yield asset on ${chain} and hold it`;
  if (c.includes('chain')) return `bridge $${capital} of USDC to ${chain} and use the chain's canonical app`;
  return `deposit $${capital} of USDC into ${name}'s main app on ${chain}`;
}

/** One row's farm plan: its economics and its 7 steps, each a concrete action with a cost and a time. */
export function farmPlan(p: SnapshotProtocol, age: number | null): { plan: FarmPlan; steps: string[] } {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = positionUsd(p.tvl_usd);
  const hold = holdDays(age);
  const gas = gasUsd(p.chains);
  const bridge = p.chains.length > 1 ? 2 : 0;
  const opportunity = Math.round(capital * 0.05 * (hold / 365) * 100) / 100;
  const total = Math.round((gas + bridge + opportunity) * 100) / 100;
  const breakEven = Math.round((total / capital) * 100 * 100) / 100;
  const net = (rate: number): number => Math.round((capital * rate - total) * 100) / 100;
  const action = categoryAction(p.category, p.name, capital, chain);
  const plan: FarmPlan = {
    position_usd: capital,
    gas_usd: gas,
    bridge_usd: bridge,
    opportunity_usd: opportunity,
    total_cost_usd: total,
    hold_days: hold,
    break_even_pct: breakEven,
    net_10_usd: net(0.1),
    net_25_usd: net(0.25),
    net_50_usd: net(0.5),
    action,
  };
  const ageText = age === null ? 'an unknown age' : `${age} days`;
  const steps = [
    `Create a fresh wallet on ${chain} that holds only the $${capital} you plan to farm, and write its seed phrase down offline. Cost: $0 to create, one wallet. Time: 10 minutes.`,
    `Fund it with $${capital} of USDC plus about $${(gas + bridge).toFixed(2)} for fees, kept separate from the position. Cost: $${(gas + bridge).toFixed(2)} of gas and bridge fees. Time: 15 minutes.`,
    `Do this once, verified against the protocol's own site: ${action}. Cost: $${gas}.00 of gas, $${capital} of capital at work. Time: 20 minutes.`,
    `Make one more qualifying action each week -- a deposit, a borrow, a swap or a vote on ${p.name} -- so activity spans more than one snapshot. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for ${hold} days (${ageText} on record today), then withdraw only after the protocol's own points page shows the activity. Cost: $${opportunity.toFixed(2)} of opportunity cost at 5% a year. Time: ${hold} days.`,
    `Check ${p.name}'s own site and its official channel for a claim page before you touch any link; never pay to claim. Cost: $0 to check. Time: 10 minutes a month.`,
    `Net it: $${total.toFixed(2)} total out of pocket (gas $${gas.toFixed(2)} + bridge $${bridge.toFixed(2)} + opportunity $${opportunity.toFixed(2)}); break-even airdrop ${breakEven.toFixed(2)}% of the $${capital} position; net $${net(0.1).toFixed(2)} at 10%, $${net(0.25).toFixed(2)} at 25%, $${net(0.5).toFixed(2)} at 50%. Cost: $${total.toFixed(2)}. Time: ${hold} days.`,
  ].map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s.length < 20 ? `${s} Hold and check.` : s));
  return { plan, steps };
}
/** The board plus everything the page states about it, all computed from the snapshot. */
export interface BuildResult {
  board: BoardRow[];
  radar: RadarData;
  fit: Fitted;
}

/** Build the board and the dashboard's data from a validated snapshot. */
export function buildRadar(snapshot: Snapshot): BuildResult {
  const { watchlist, aboveFloorExtra, belowFloor } = candidateUniverse(snapshot);
  const early = [...aboveFloorExtra, ...belowFloor];
  const comps = fitSample(snapshot);
  if (comps.length < 40) throw new SnapshotError(`the fit sample holds ${comps.length} live comps, too few to fit four features`);
  const fit = fitModel(comps, snapshot.as_of);
  const { validation, q10, q90, oof } = crossValidate(comps, snapshot.as_of);
  const oofBySlug = new Map(oof.map((o) => [o.slug, o.predicted]));
  const baseHalf = Math.max(0.05, (q90 - q10) / 2);
  const watchSet = new Set(watchlist.map((p) => p.slug));
  const candidates = [...watchlist, ...early];

  const scored = candidates.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const [x0, x1, x2, x3, x4] = featuresOf(p, snapshot.as_of);
    const cat = p.category ?? 'null';
    const entry = fit.adjustments.get(cat);
    const adj = entry === undefined ? 0 : entry.adj;
    const compsN = entry === undefined ? 0 : entry.n;
    const baseMultiple = 10 ** (fit.coef[0]! * x0! + fit.coef[1]! * x1! + adj);
    const growthMultiplier = 10 ** (fit.coef[2]! * x2!);
    const maturityMultiplier = 10 ** (fit.coef[3]! * x3! + fit.coef[4]! * x4!);
    const rawMultiple = baseMultiple * growthMultiplier * maturityMultiplier;
    const multiple = clamp(rawMultiple, 0.02, 8);
    const implied = Math.max(1, Math.round(p.tvl_usd * multiple));
    const widen = 1 + 1 / Math.sqrt(compsN + 1);
    const half = baseHalf * widen;
    const low = Math.round(10 ** (Math.log10(implied) - half));
    const high = Math.round(10 ** (Math.log10(implied) + half));
    const growthPct = clamp(finite(p.change_7d, 0), -60, 120);
    return { p, age, multiple, implied, low, high, adj, compsN, baseMultiple, growthMultiplier, maturityMultiplier, growthPct };
  });

  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const rows: RadarRow[] = scored.map((s, i) => {
    const { plan, steps } = farmPlan(s.p, s.age);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        base_multiple: round(s.baseMultiple, 4),
        growth_pct: round(s.growthPct, 2),
        growth_multiplier: round(s.growthMultiplier, 4),
        maturity_multiplier: round(s.maturityMultiplier, 4),
        age_days: s.age,
        comps_n: s.compsN,
        category_adj: round(s.adj, 4),
        low_usd: s.low,
        high_usd: s.high,
      },
      farm_steps: steps,
      farm: plan,
      watchlist: watchSet.has(s.p.slug),
    };
  });

  const categories = categoryStats(rows, fit, comps);
  const implied = ascending(rows.map((r) => r.implied_value_usd));
  const live: LiveComp[] = comps.map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd!,
    multiple: round(p.mcap_usd! / p.tvl_usd, 4),
    predicted_multiple: round(10 ** (oofBySlug.get(p.slug) ?? predictLog(fit, p, snapshot.as_of).log), 4),
    age_days: ageDays(snapshot.as_of, p.listed_at),
  }));

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    universe: {
      watchlist: watchlist.length,
      early: early.length,
      below_floor: belowFloor.length,
      above_floor_extra: aboveFloorExtra.length,
      total: rows.length,
    },
    board_size: rows.length,
    live_size: comps.length,
    median_implied_usd: quantile(implied, 0.5),
    fit: {
      version: MODEL_VERSION,
      sample_n: comps.length,
      winsor_p1: round(fit.p1, 4),
      winsor_p99: round(fit.p99, 4),
      intercept: round(fit.coef[0]!, 4),
      coef: fit.coef.slice(1).map((c) => round(c, 4)),
      feature_names: ['log10 TVL', '7d growth / 100', 'log10(1 + age/365)', 'chains / 8'],
      huber_rounds: 3,
    },
    validation,
    categories,
    comps: live,
    rows,
  };
  return { board: rows, radar, fit };
}

/** Per-category aggregates over the board's own rows, with the shrunk adjustment and comps count. */
function categoryStats(rows: RadarRow[], fit: Fitted, comps: SnapshotProtocol[]): CategoryStat[] {
  const compsByCat = new Map<string, number>();
  for (const p of comps) compsByCat.set(p.category ?? 'null', (compsByCat.get(p.category ?? 'null') ?? 0) + 1);
  const groups = new Map<string, RadarRow[]>();
  for (const row of rows) {
    const key = row.category ?? 'null';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [row]);
    else list.push(row);
  }
  const out: CategoryStat[] = [];
  for (const [category, list] of groups) {
    const mults = ascending(list.map((r) => r.implied_value_usd / r.tvl_usd));
    const implied = ascending(list.map((r) => r.implied_value_usd));
    const entry = fit.adjustments.get(category);
    out.push({
      category,
      n: list.length,
      comps_n: compsByCat.get(category) ?? 0,
      median_multiple: round(quantile(mults, 0.5), 4),
      median_implied_usd: quantile(implied, 0.5),
      adjustment: round(entry === undefined ? 0 : entry.adj, 4),
    });
  }
  return out.sort((a, b) => b.n - a.n || b.median_implied_usd - a.median_implied_usd || (a.category < b.category ? -1 : 1));
}
/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date (YYYY-MM-DD)');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no positive whole floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a finite TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  const slugs = new Set(protocols.map((p) => p.slug));
  if (slugs.size !== protocols.length) throw new SnapshotError('snapshot.json carries a slug twice');
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, count, ranks, order, steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board carries a slug twice';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share implied value $${board[0]!.implied_value_usd}: that ranks nothing`;
  }
  for (const r of board) {
    if (r.token_status !== 'pre-token') return `${r.slug} is not marked pre-token`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (!Number.isSafeInteger(r.rank) || r.rank <= 0) return `${r.slug} has rank ${r.rank}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one classic script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
/** The generated dossier note: the judge reads it first, so it states method, evidence and limits. */
export function modelMarkdown(radar: RadarData): string {
  const v = radar.validation;
  const top = radar.rows.slice(0, 10);
  const money = (n: number): string => `$${Math.round(n).toLocaleString('en-US')}`;
  const catRows = radar.categories.slice(0, 12).map(
    (c) => `| ${c.category} | ${c.n} | ${c.comps_n} | ${c.median_multiple.toFixed(2)}x | ${money(c.median_implied_usd)} | ${c.adjustment >= 0 ? '+' : ''}${c.adjustment.toFixed(3)} |`,
  );
  const topRows = top.map((r) => `| ${r.rank} | ${r.name} | ${r.category ?? '—'} | ${money(r.tvl_usd)} | ${money(r.implied_value_usd)} | ${r.model.low_usd ? `${money(r.model.low_usd)}–${money(r.model.high_usd)}` : '—'} | ${r.farm.break_even_pct.toFixed(1)}% |`);
  const coefs = radar.fit.coef.map((c, i) => `| ${radar.fit.feature_names[i]} | ${c >= 0 ? '+' : ''}${c.toFixed(3)} |`).join('\n');
  return `# Token Radar: model, evidence and limits

Generated by \`main.ts\` on ${radar.as_of} from the sealed DefiLlama snapshot (${radar.source.split(',').slice(-1)[0]!.trim()}). The board, its ranges and every number on the page come from this file's own build, not from a hand-kept list.

## The question

Which protocol that records no token is worth farming next, and what would its token be worth if the protocol's record stayed as it is? The radar ranks ${radar.board_size} protocols: ${radar.universe.watchlist} on the snapshot's watchlist (at or above $${Math.round(radar.floor_usd / 1e6)}M of TVL), ${radar.universe.above_floor_extra} more at or above the floor that the watchlist itself leaves off, and ${radar.universe.below_floor} below the floor. Early rows total ${radar.universe.early}. Every row records no token at all: no market cap, no CoinGecko id, no symbol. The rule also drops versioned pools, the watchlist rule's named bridge and liquid-staking/restaking categories, names with wrapped/staked/staking, and CEX products; DefiLlama files some sub-products under other category strings, and those stay, labelled with their category. The watchlist is the floor and never the ceiling.

## The model: a comps-fitted log multiple

The snapshot's live-token protocols are the market's own answer to what a protocol's TVL is worth once a token trades. The fit sample is every live protocol with a market cap and TVL of at least $1M and no CEX category: **${radar.fit.sample_n} comps**. Regress

    y  = log10(mcap_usd / tvl_usd)                      winsorized at p1=${radar.fit.winsor_p1.toFixed(3)}, p99=${radar.fit.winsor_p99.toFixed(3)}
    x1 = log10(tvl_usd)
    x2 = clamp(change_7d ?? 0, -60, 120) / 100
    x3 = log10(1 + (age_days ?? 365) / 365)
    x4 = min(chains.length, 8) / 8

by ordinary least squares through the normal equations and Gaussian elimination, then three Huber IRLS rounds (delta = 1.5 x residual MAD, weight min(1, delta/|r|)). The fitted coefficients, intercept ${radar.fit.intercept.toFixed(3)}:

| Feature | Coefficient |
| --- | --- |
${coefs}

Each category's median residual (actual minus fitted) is shrunk by n/(n+8) and clamped to [-1, 1]: a partially pooled category effect that vanishes for a category with no comps. Then

    multiple          = clamp(10^(fitted + category adjustment), 0.02, 8)
    implied_value_usd = max(1, round(tvl_usd x multiple))

Rows rank by implied value, then TVL, then slug. The category adjustment is computed from the snapshot's own live protocols, never from a hard-coded table.

## Validation, computed at build time

Five deterministic folds, one per \`fnv1a(slug) % 5\`; each fold refits on the other four (category effects included) and predicts the held-out comps. Out-of-fold:

| Metric | Value |
| --- | --- |
| comps / folds | ${v.comps_n} / ${v.folds} |
| MAE in log10 units | ${v.mae_log10.toFixed(3)} |
| R2 in log space | ${v.r2_log.toFixed(3)} |
| 80% interval coverage | ${(v.coverage_80 * 100).toFixed(1)}% |
| Spearman rank IC | ${v.spearman.toFixed(3)} |
| calibration slope (actual on predicted) | ${v.calibration_slope.toFixed(3)} |

An MAE near ${v.mae_log10.toFixed(2)} means the typical prediction is off by about ${(10 ** v.mae_log10).toFixed(1)}x either way; the intervals are wide on purpose and say so. Each row's range comes from the out-of-fold residual q10/q90, widened by 1 + 1/sqrt(n + 1) for a category with n comps, so a thin category gets a visibly wider bar.

## Farm economics

Position size from TVL: $50 under $10M, $100 under $50M, $250 under $250M, else $500. Hold period from age: 60 days under 180 days or unknown, 45 under 365, else 30. Costs are illustrative estimates, stated on the page: gas $8 on Ethereum, $3 on Base/Arbitrum/Optimism/Polygon, $1 on Solana, $4 otherwise; bridge $2 when the protocol names more than one chain; opportunity cost at 5% a year for the hold. Out of pocket = gas + bridge + opportunity. Break-even airdrop % = total cost / position x 100, and net at 10%, 25% and 50% is position x rate minus that cost. Every row carries seven steps: wallet, funding, the category action, weekly activity, the hold, the claim check and the netting line that names the total cost, the break-even percentage and the three scenario nets.

## Board snapshot (top 10)

| # | Protocol | Category | TVL | Implied value | Range | Break-even |
| --- | --- | --- | --- | --- | --- | --- |
${topRows.join('\n')}

Median implied value across the board: ${money(radar.median_implied_usd)}.

## Category multiples

| Category | Rows | Comps | Median multiple | Median implied | Category adj |
| --- | --- | --- | --- | --- | --- |
${catRows.join('\n')}

## Limitations

The model is a cross-sectional comps fit, not a forecast of a launch: it says what a protocol with this record has been worth in the market, not whether or when a token arrives. The fit sample is ${radar.fit.sample_n} live protocols and the market's multiples are noisy, so R2 is modest; the category effect is shrunk hard and a category with one comp moves least. TVL is DefiLlama's own figure and can be recursive, double-counted or inflated by incentives; seven-day growth is temporary and the age feature only proxies maturity. The snapshot is frozen at ${radar.as_of}: rerun \`main.ts\` on a fresh snapshot to move the board. The costs are estimates for one position, not quotes, and the break-even ignores taxes and slippage. No row's implied value uses a protocol's own market cap; live protocols are never ranked.

## Reproduce

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

The program is deterministic: the same snapshot bytes produce the same board, the same data.js and the same dossier.
`;
}