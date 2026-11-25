import { buildValuation } from './valuation.ts';
import { buildOdds } from './odds.ts';
import { FARM_ASSUMPTIONS, farmFor, farmStepStrings } from './farm.ts';

export interface Protocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
export interface Snapshot {
  as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[];
}
export type BoardRow = Protocol & Record<string, any>;
export const SEALED_SHA256 = '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393';
export const isPreToken = (p: Protocol) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const days = (Date.parse(asOf) - Date.parse(listedAt)) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days) : null;
}
export function parseSnapshot(input: unknown): Snapshot {
  const raw: any = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || !Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) throw new Error('Invalid sealed snapshot structure');
  const slugs = new Set();
  for (const p of raw.protocols) {
    if (!p.slug || !p.name || slugs.has(p.slug) || !Number.isFinite(p.tvl_usd) || p.tvl_usd < 0 || !Array.isArray(p.chains)) throw new Error('Invalid protocol identity, TVL or chains');
    slugs.add(p.slug);
    for (const key of ['mcap_usd', 'change_7d']) if (p[key] !== null && !Number.isFinite(p[key])) throw new Error(`Invalid ${key}: ${p.slug}`);
  }
  return raw as Snapshot;
}
/** Original v1 selection: valuation never decides eligibility. */
export function selectProtocols(snapshot: Snapshot): Protocol[] {
  const index = new Map(snapshot.protocols.map(p => [p.slug, p]));
  const watch = new Set(snapshot.watchlist);
  const selected = snapshot.watchlist.map(slug => {
    const p = index.get(slug);
    if (!p || !isPreToken(p)) throw new Error(`Invalid pre-token watchlist member: ${slug}`);
    return p;
  });
  const other = snapshot.protocols.filter(p => isPreToken(p) && !watch.has(p.slug) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug)).slice(0, 160);
  if (other.length !== 160) throw new Error('Required 160 below-floor rows unavailable');
  return [...selected, ...other];
}
function quantile(values: number[], q: number) {
  const a = [...values].sort((x, y) => x - y), at = (a.length - 1) * q;
  return a[Math.floor(at)]! + (a[Math.ceil(at)]! - a[Math.floor(at)]!) * (at % 1);
}
/** Recalculate old model on the same snapshot solely to explain rank migration. */
function legacyRanking(snapshot: Snapshot, selected: Protocol[]) {
  const comps = snapshot.protocols.filter(p => !isPreToken(p) && (p.mcap_usd ?? 0) > 0 && p.tvl_usd > 0 && p.category !== null);
  const logs = comps.map(p => Math.log(p.mcap_usd! / p.tvl_usd));
  const global = Math.exp(quantile(logs, .5)), lo = quantile(logs, .1), hi = quantile(logs, .9);
  return selected.map(p => {
    const cat = comps.filter(c => c.category === p.category).map(c => Math.log(c.mcap_usd! / c.tvl_usd));
    const w = cat.length / (cat.length + 8);
    const multiple = cat.length ? Math.exp(Math.max(lo, Math.min(hi, quantile(cat, .5)))) * w + global * (1 - w) : global;
    const age = ageInDays(snapshot.as_of, p.listed_at);
    const growth = p.change_7d === null ? 1 : Math.exp(.22 * Math.tanh(p.change_7d / 25));
    const maturity = age === null ? 1 : .75 + .45 * (1 - Math.exp(-age / 180)) * Math.exp(-Math.max(0, age - 1095) / 1460);
    const chains = 1 + .07 * Math.log2(Math.min(8, Math.max(1, p.chains.length)));
    const completeness = (p.change_7d === null ? .92 : 1) * (age === null ? .88 : 1) * (p.category === null ? .92 : 1);
    return { slug: p.slug, name: p.name, implied_value_usd: p.tvl_usd * multiple * growth * maturity * chains * completeness };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug)).map((r, i) => ({ ...r, rank: i + 1 }));
}
const runs = new WeakMap<Snapshot, any>();
export function buildRankBoard(snapshot: Snapshot): BoardRow[] {
  const selected = selectProtocols(snapshot), valuation = buildValuation(snapshot, selected), odds = buildOdds(snapshot, selected);
  const watch = new Set(snapshot.watchlist);
  const board = selected.map(p => {
    const value = valuation.rows[p.slug], probability = odds.rows[p.slug];
    const farm = farmFor(p, value, probability.token_probability);
    return { ...p, ...value, ...probability, age_days: ageInDays(snapshot.as_of, p.listed_at), rank: 0,
      has_token: false, watchlist: watch.has(p.slug), selection_reason: watch.has(p.slug) ? 'Watchlist' : 'Below TVL floor: top 160 by TVL',
      expected_value_usd: value.implied_value_usd * probability.token_probability, farm, farm_steps: farmStepStrings(farm) };
  }).sort((a, b) => b.implied_value_usd - a.implied_value_usd || a.slug.localeCompare(b.slug));
  board.forEach((row, index) => row.rank = index + 1);
  runs.set(snapshot, { valuation: valuation.report, odds: odds.report, legacy: legacyRanking(snapshot, selected) });
  return board;
}
export function buildIssuedRows(snapshot: Snapshot) {
  return snapshot.protocols.filter(p => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? -Infinity) - (a.mcap_usd ?? -Infinity) || a.slug.localeCompare(b.slug))
    .map(p => ({ ...p, has_token: true, age_days: ageInDays(snapshot.as_of, p.listed_at) }));
}
export function buildAudit(snapshot: Snapshot, board: BoardRow[]) {
  const selected = new Set(board.map(r => r.slug));
  return snapshot.protocols.filter(p => isPreToken(p) && !selected.has(p.slug)).map(p => ({ ...p,
    reason: p.tvl_usd >= snapshot.floor_usd
      ? 'Not on watchlist; TVL at or above the sealed below-floor selection boundary'
      : 'Not on watchlist; below-floor TVL outside the 160 available selection slots',
  })).sort((a, b) => b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug));
}
export function evaluateIntegrity(snapshot: Snapshot, board: BoardRow[], issued: any[], audit: any[], digest: string) {
  const slugs = [...board, ...issued, ...audit].map(r => r.slug), source = new Set(snapshot.protocols.map(p => p.slug));
  const boardSlugs = new Set(board.map(r => r.slug)), checks: any[] = [];
  const check = (id: string, label: string, pass: boolean, actual: unknown, expected: unknown) => checks.push({ id, label, pass, actual, expected });
  check('rows', 'Board rows', board.length === 200, board.length, 200);
  check('ranks', 'Continuous ranks', board.length === 200 && board.every((r, i) => r.rank === i + 1), `1–${board.length}`, '1–200 in row order');
  check('order', 'Strict value order', board.every((r, i) => Number.isFinite(r.implied_value_usd) && r.implied_value_usd > 0 && (i === 0 || board[i - 1]!.implied_value_usd > r.implied_value_usd)), `${new Set(board.map(r => r.implied_value_usd)).size} distinct`, 'Positive, finite, strictly decreasing');
  const coverage = snapshot.watchlist.filter(slug => boardSlugs.has(slug)).length;
  check('watchlist', 'Watchlist coverage', snapshot.watchlist.length === 40 && coverage === 40 && board.filter(r => r.watchlist).length === 40 && board.every(r => Boolean(r.watchlist) === snapshot.watchlist.includes(r.slug)), `${coverage}/${snapshot.watchlist.length}`, '40/40 with truthful flags');
  const tokenCount = board.filter(r => !isPreToken(r) || r.has_token !== false).length;
  check('tokens', 'Issued tokens on board', tokenCount === 0, tokenCount, 0);
  const classified = slugs.length === snapshot.protocols.length && new Set(slugs).size === source.size && slugs.every(s => source.has(s)) && issued.every(p => !isPreToken(p)) && audit.every(p => isPreToken(p) && Boolean(p.reason));
  check('accounting', 'Universe accounted for', snapshot.protocols.length === 758 && classified, `${board.length} + ${issued.length} + ${audit.length} = ${slugs.length}`, `${snapshot.protocols.length} unique source identities`);
  check('issued', 'Issued inventory', issued.length === snapshot.protocols.filter(p => !isPreToken(p)).length && issued.length === 416, issued.length, 416);
  check('selection', 'Original selection preserved', board.length === 200 && selectProtocols(snapshot).every(p => boardSlugs.has(p.slug)), boardSlugs.size, 'Same 40 watchlist + 160 below-floor');
  check('seal', 'Snapshot seal', digest === SEALED_SHA256 && snapshot.as_of === '2026-11-14', digest, SEALED_SHA256);
  check('steps', 'Farm workflow', board.every(r => r.farm_steps?.length === 6 && r.farm_steps.every((s: string) => s.length >= 20 && s.length <= 600)), '6 steps per row', '6 steps, 20–600 characters');
  return { checks, counts: { ranked: board.length, issued: issued.length, excluded: audit.length, total: snapshot.protocols.length }, snapshot_sha256: digest,
    source_slugs: snapshot.protocols.map(p => p.slug), selected_slugs: selectProtocols(snapshot).map(p => p.slug), pass: checks.every(c => c.pass) };
}
export function buildDashboardData(snapshot: Snapshot, board: BoardRow[], digest: string) {
  const run = runs.get(snapshot);
  if (!run) throw new Error('Build board before dashboard');
  const issued = buildIssuedRows(snapshot), audit = buildAudit(snapshot, board);
  const migration = run.legacy.slice(0, 5).map((old: any) => {
    const row = board.find(r => r.slug === old.slug)!;
    return { name: row.name, slug: row.slug, old_rank: old.rank, new_rank: row.rank, old_value_usd: old.implied_value_usd, new_value_usd: row.implied_value_usd,
      reason: 'Same sealed selection; v2 replaces the unvalidated multiplier product with the curve and terms selected by both holdout diagnostics. No protocol-specific overrides.' };
  });
  return {
    schema: 'token-radar/v2', snapshot: { as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd, protocol_count: snapshot.protocols.length, watchlist_count: snapshot.watchlist.length, watchlist: [...snapshot.watchlist] },
    model: { formula: run.valuation.selected.equation, valuation: run.valuation, odds: run.odds, farm_assumptions: FARM_ASSUMPTIONS, rank_migration: migration },
    board, issued, audit, integrity: evaluateIntegrity(snapshot, board, issued, audit, digest),
    categories: [...new Set(snapshot.protocols.map(p => p.category).filter(Boolean))].sort(), chains: [...new Set(snapshot.protocols.flatMap(p => p.chains))].sort(),
  };
}
