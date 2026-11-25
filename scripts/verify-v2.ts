import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { evaluateIntegrity } from '../lib/model.ts';

// Independent artifact arithmetic and negative controls. No rebuild, network or input writes.
const root = resolve('.');
const snapshotBytes = readFileSync(resolve(root, 'input/snapshot.json'));
const snapshot = JSON.parse(snapshotBytes.toString('utf8'));
const digest = createHash('sha256').update(snapshotBytes).digest('hex');
const board = JSON.parse(readFileSync(resolve(root, 'out/board.json'), 'utf8'));
const context: any = {};
runInNewContext(readFileSync(resolve(root, 'out/data.js'), 'utf8'), context, { timeout: 5000 });
const data = context.__TOKEN_RADAR__;
const checks: any[] = [];
const samples: any[] = [];
function check(id: string, pass: boolean, detail: any = '') {
  checks.push({ id, pass, detail });
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'} ${id}${detail === '' ? '' : ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}\n`);
}
function near(a: number, b: number, tolerance = 1e-9): boolean {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b));
}
function assert(condition: boolean, message: string) { if (!condition) throw new Error(message); }
function q(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * p;
  const index = Math.floor(at);
  return sorted[index]! + (sorted[Math.ceil(at)]! - sorted[index]!) * (at - index);
}
const pretoken = (p: any) => p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
const bySlug = new Map(snapshot.protocols.map((p: any) => [p.slug, p]));
const ageOf = (p: any): number | null => p.listed_at === null ? null
  : Math.max(0, Math.floor((Date.parse(snapshot.as_of + 'T00:00:00Z') - Date.parse(p.listed_at + 'T00:00:00Z')) / 86_400_000));
const valuation = data?.valuation ?? data?.model?.valuation;
const oddsReport = data?.odds ?? data?.model?.odds;
const assumptions = data?.farm_assumptions ?? data?.model?.farm_assumptions;
const audit = data?.audit ?? [];
const issued = data?.issued ?? [];

check('sealed snapshot bytes', digest === '42a71213519479f3a180cc5010cbbf6bd18a2447fa0ad29e4c5122b6c9184393', digest);
check('schema v2', data?.schema === 'token-radar/v2');
check('board/data agreement', JSON.stringify(board) === JSON.stringify(data?.board));
check('fixed structural contract', board.length === 200 && snapshot.watchlist.length === 40 && snapshot.protocols.length === 758
  && issued.length === 416 && audit.length === 142 && snapshot.as_of === '2026-11-14');
check('source references removed', !existsSync(resolve(root, 'refs')));

const integrity = evaluateIntegrity(snapshot, board, issued, audit, digest);
for (const item of integrity.checks) check(`integrity ${item.id}`, item.pass, item.detail ?? item.actual ?? '');

// Each deliberate corruption must trip its own invariant, rather than merely
// triggering an unrelated aggregate check. IDs mirror the public integrity strip.
const mutations: { name: string; expected: string; mutate: (b: any[], i: any[], a: any[]) => void }[] = [
  { name: 'removed row', expected: 'rows', mutate: b => { b.pop(); } },
  { name: 'duplicate rank', expected: 'ranks', mutate: b => { b[1].rank = b[0].rank; } },
  { name: 'tied value', expected: 'order', mutate: b => { b[1].implied_value_usd = b[0].implied_value_usd; } },
  { name: 'missing watchlist protocol', expected: 'watchlist', mutate: b => { b.splice(b.findIndex(r => snapshot.watchlist.includes(r.slug)), 1); } },
  { name: 'token symbol contamination', expected: 'tokens', mutate: b => { b[0].symbol = 'TEST'; } },
  { name: 'missing audit entry', expected: 'accounting', mutate: (_b, _i, a) => { a.pop(); } },
  { name: 'missing issued entry', expected: 'issued', mutate: (_b, i) => { i.pop(); } },
  { name: 'changed selection', expected: 'selection', mutate: (b, _i, a) => {
    const index = b.findIndex(r => !r.watchlist);
    const previous = b[index];
    b[index] = { ...previous, ...a[0] };
    a[0] = { ...(bySlug.get(previous.slug) as any), reason: 'Deliberate selection negative control' };
  } },
  { name: 'missing farm step', expected: 'steps', mutate: b => { b[0].farm_steps.pop(); } },
];
for (const mutation of mutations) {
  const b = structuredClone(board), i = structuredClone(issued), a = structuredClone(audit);
  mutation.mutate(b, i, a);
  const result = evaluateIntegrity(snapshot, b, i, a, digest);
  const failure = result.checks.find((c: any) => c.id === mutation.expected);
  check(`negative control ${mutation.name}`, failure?.pass === false, mutation.expected);
}
check('negative control broken seal', evaluateIntegrity(snapshot, board, issued, audit, 'deliberately invalid digest').checks.find((c: any) => c.id === 'seal')?.pass === false, 'seal');

const watch = new Set(snapshot.watchlist);
const expectedSlugs = new Set([
  ...snapshot.watchlist,
  ...snapshot.protocols.filter((p: any) => pretoken(p) && !watch.has(p.slug) && p.tvl_usd < snapshot.floor_usd)
    .sort((a: any, b: any) => b.tvl_usd - a.tvl_usd || a.slug.localeCompare(b.slug)).slice(0, 160).map((p: any) => p.slug),
]);
check('v1 selected population preserved', board.every((r: any) => expectedSlugs.has(r.slug)) && expectedSlugs.size === board.length);

const sampleRanks = new Set([1, 2, Math.ceil(board.length / 2), board.length]);
const unknownAge = board.find((r: any) => r.listed_at === null);
if (unknownAge) sampleRanks.add(unknownAge.rank);
const comps = snapshot.protocols.filter((p: any) => p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== null);
const compLogRatios = comps.map((p: any) => Math.log(p.mcap_usd / p.tvl_usd));
const globalMultiple = Math.exp(q(compLogRatios, 0.5));
try {
  assert(Boolean(assumptions), 'Missing exposed farm assumptions');
  for (const row of board) {
    const source: any = bySlug.get(row.slug);
    assert(Boolean(source), `${row.slug} not in sealed input`);
    for (const key of Object.keys(source)) assert(JSON.stringify(source[key]) === JSON.stringify(row[key]), `${row.slug} source field changed: ${key}`);
    assert(pretoken(row), `${row.slug} has token evidence`);
    assert(row.farm_steps.length === 6 && row.farm_steps.every((s: string) => s.length >= 20 && s.length <= 600), `${row.slug} farm prose size`);

    // Recount supporting peers directly from the immutable snapshot. The target
    // protocol and its known negative label are excluded from all support counts.
    const o = row.odds;
    const peers = snapshot.protocols.filter((p: any) => p.slug !== row.slug);
    const peerAges = peers.flatMap((p: any) => ageOf(p) === null ? [] : [ageOf(p)]);
    assert(o.age_cutpoints_days[0] === Math.round(q(peerAges, 1 / 3))
      && o.age_cutpoints_days[1] === Math.round(q(peerAges, 2 / 3))
      && near(o.tvl_cutpoint_usd, q(peers.map((p: any) => p.tvl_usd), 0.5)), `${row.slug} train-only quantile cutpoints`);
    const band = (p: any) => {
      const age = ageOf(p);
      return [age === null ? -1 : age <= o.age_cutpoints_days[0] ? 0 : age <= o.age_cutpoints_days[1] ? 1 : 2,
        p.tvl_usd <= o.tvl_cutpoint_usd ? 0 : 1];
    };
    const targetBand = JSON.stringify(band(source));
    const parent = peers.filter((p: any) => JSON.stringify(band(p)) === targetBand);
    const cell = parent.filter((p: any) => p.category === source.category);
    const positive = (ps: any[]) => ps.filter(p => !pretoken(p)).length;
    const parentCounts: Record<string, number> = {};
    peers.forEach((p: any) => { const key = JSON.stringify(band(p)); parentCounts[key] = (parentCounts[key] ?? 0) + 1; });
    const strength = Math.sqrt(q(Object.values(parentCounts), 0.5));
    const parentStrength = Math.sqrt(peers.length);
    const global = positive(peers) / peers.length;
    const prior = (positive(parent) + parentStrength * global) / (parent.length + parentStrength);
    const probability = (positive(cell) + strength * prior) / (cell.length + strength);
    assert(o.excluded_target === true && o.global_n === peers.length && o.global_issued === positive(peers), `${row.slug} target exclusion`);
    assert(o.cell_n === cell.length && o.cell_issued === positive(cell) && o.parent_n === parent.length && o.parent_issued === positive(parent), `${row.slug} support count`);
    assert(near(o.prior_strength, strength) && near(o.parent_prior_strength, parentStrength) && near(o.prior_rate, prior), `${row.slug} odds prior`);
    assert(near(row.token_probability, probability) && near(o.probability, probability), `${row.slug} odds formula`);

    const f = row.farm;
    const transactions = f.steps.reduce((sum: number, s: any) => sum + s.transactions, 0);
    const minutes = f.steps.reduce((sum: number, s: any) => sum + s.minutes, 0);
    const gas = transactions * assumptions.gas_per_transaction_usd;
    const hours = minutes / 60;
    const timeCost = hours * assumptions.time_value_usd_per_hour;
    const cost = gas + timeCost;
    const share = assumptions.pool_fraction / assumptions.qualifying_wallets;
    const payout = row.implied_value_usd * probability * share;
    const p10Value = Math.min(row.implied_p10_usd, row.bootstrap_p10_usd);
    const p10Payout = p10Value * probability * share;
    const net = payout - cost, p10Net = p10Payout - cost;
    const expectedVerdict = p10Net < 0 ? 'SKIP' : p10Net < cost ? 'THIN' : 'FARM';
    const capital = Math.max(80, Math.min(1500, Math.round(Math.sqrt(source.tvl_usd) / 120)));
    for (const [key, expected] of Object.entries({ capital_usd: capital, gas_usd: gas, transactions, time_hours: hours,
      time_cost_usd: timeCost, total_cost_usd: cost, reserve_usd: capital + gas, weekly_hours: hours / assumptions.hold_weeks,
      expected_airdrop_usd: payout, p10_airdrop_usd: p10Payout, net_usd: net, p10_net_usd: p10Net,
      net_per_hour: net / hours, p10_net_per_hour: p10Net / hours, farmer_share: share,
      break_even_share: cost / (row.implied_value_usd * probability),
      p10_break_even_share: cost / (p10Value * probability),
      break_even_wallets: assumptions.pool_fraction * row.implied_value_usd * probability / cost,
      min_pool_fraction: cost / (row.implied_value_usd * probability) * assumptions.qualifying_wallets })) {
      assert(near(f[key], expected), `${row.slug} farm ${key}: ${f[key]} vs ${expected}`);
    }
    assert(f.verdict === expectedVerdict, `${row.slug} P10 verdict`);
    assert(f.steps.every((s: any) => near(s.gas_usd, s.transactions * assumptions.gas_per_transaction_usd)), `${row.slug} step gas`);
    assert(row.implied_p10_usd > 0 && row.implied_p10_usd <= row.implied_p90_usd
      && row.bootstrap_p10_usd > 0 && row.bootstrap_p10_usd <= row.bootstrap_p90_usd
      && row.rank_p10 >= 1 && row.rank_p90 <= board.length && row.rank_p10 <= row.rank_p90, `${row.slug} interval endpoints`);
    const detail = row.valuation_details;
    const categoryLogs = comps.filter((p: any) => p.category === source.category).map((p: any) => Math.log(p.mcap_usd / p.tvl_usd));
    const categoryWeight = categoryLogs.length / (categoryLogs.length + 8);
    const categoryMultiple = categoryLogs.length ? Math.exp(Math.max(q(compLogRatios, 0.1), Math.min(q(compLogRatios, 0.9), q(categoryLogs, 0.5)))) * categoryWeight
      + globalMultiple * (1 - categoryWeight) : globalMultiple;
    const days = ageOf(source);
    const rawMultipliers: Record<string, number> = {
      category: categoryMultiple,
      growth: source.change_7d === null ? 1 : Math.exp(0.22 * Math.tanh(source.change_7d / 25)),
      maturity: days === null ? 1 : 0.75 + 0.45 * (1 - Math.exp(-days / 180)) * Math.exp(-Math.max(0, days - 1095) / 1460),
      multi_chain: 1 + 0.07 * Math.log2(Math.min(8, Math.max(1, new Set(source.chains).size))),
      completeness: (source.change_7d === null ? 0.92 : 1) * (days === null ? 0.88 : 1) * (source.category === null ? 0.92 : 1),
    };
    const z = Math.log(source.tvl_usd) - valuation.fit.center_log_tvl;
    const coefficients = valuation.fit.coefficients;
    const curve = valuation.selected.form === 'category median' ? Math.log(source.tvl_usd) + Math.log(categoryMultiple)
      : coefficients[0] + coefficients[1] * z + (coefficients[2] ?? 0) * z * z;
    const offset = valuation.selected.terms.reduce((sum: number, name: string) => sum + Math.log(rawMultipliers[name]!), 0);
    const independentLogValue = curve + offset;
    const independentPoint = Math.max(1, Math.round(Math.exp(independentLogValue)));
    assert(independentPoint === row.implied_value_usd && near(independentLogValue, detail.predicted_log_value), `${row.slug} fitted curve vs snapshot`);
    assert(Math.max(1, Math.round(Math.exp(detail.predicted_log_value))) === row.implied_value_usd, `${row.slug} point arithmetic`);
    assert(Math.max(1, Math.round(Math.exp(detail.predicted_log_value + valuation.intervals.residual_p10))) === row.implied_p10_usd, `${row.slug} P10 residual arithmetic`);
    assert(Math.max(1, Math.round(Math.exp(detail.predicted_log_value + valuation.intervals.residual_p90))) === row.implied_p90_usd, `${row.slug} P90 residual arithmetic`);

    if (sampleRanks.has(row.rank)) samples.push({ rank: row.rank, slug: row.slug, snapshot_tvl_usd: source.tvl_usd,
      valuation: { z, coefficients, retained_log_offset: offset, recalculated_log_value: independentLogValue, implied_value_usd: independentPoint },
      odds: { cell_n: cell.length, cell_issued: positive(cell), parent_n: parent.length, parent_issued: positive(parent),
        prior_strength: strength, parent_prior_strength: parentStrength, prior_rate: prior, probability,
        expression: `(${positive(cell)} + ${strength} × ${prior}) / (${cell.length} + ${strength})` },
      farm: { transactions, minutes, gas_usd: gas, time_cost_usd: timeCost, cost_usd: cost, capital_usd: capital,
        implied_value_usd: row.implied_value_usd, farmer_share: share, expected_airdrop_usd: payout,
        p10_value_usd: p10Value, p10_airdrop_usd: p10Payout, net_usd: net, net_per_hour: net / hours, p10_net_usd: p10Net,
        verdict: expectedVerdict, break_even_share: cost / (row.implied_value_usd * probability) } });
  }
  check('all row snapshot/odds/farm/interval arithmetic', true, `${board.length} rows independently recomputed`);
} catch (error) { check('all row snapshot/odds/farm/interval arithmetic', false, String(error)); }

function blindMetrics(records: any[]) {
  const errors = records.map(r => Math.abs(Math.log(r.predicted_usd / (bySlug.get(r.slug) as any).mcap_usd)));
  return { n: records.length, median_abs_log_error: q(errors, 0.5), median_error_factor: Math.exp(q(errors, 0.5)),
    mean_abs_log_error: errors.reduce((a, b) => a + b, 0) / errors.length,
    median_predicted_actual_ratio: q(records.map(r => r.predicted_usd / (bySlug.get(r.slug) as any).mcap_usd), 0.5),
    within_2x: errors.filter(x => x <= Math.log(2)).length / errors.length };
}
const blind: any = {};
try {
  for (const [name, records, reported] of [
    ['loo', valuation.validation.loo_predictions, valuation.validation.loo],
    ['walk_forward', valuation.validation.walk_forward_predictions, valuation.validation.walk_forward],
    ['nested_audit', valuation.validation.nested_audit.predictions, valuation.validation.nested_audit.metrics],
  ] as any[]) {
    assert(new Set(records.map((r: any) => r.slug)).size === records.length, `${name} repeats a heldout protocol`);
    for (const r of records) {
      const source: any = bySlug.get(r.slug);
      assert(source.mcap_usd > 0 && source.tvl_usd > 0, `${name} invalid comparable`);
      assert(near(r.actual_ratio, source.mcap_usd / source.tvl_usd) && near(r.predicted_ratio, r.predicted_usd / source.tvl_usd), `${name} ratio mismatch`);
      assert(near(r.log_error, Math.log(r.predicted_usd / source.mcap_usd)) && near(r.residual, -r.log_error), `${name} error mismatch`);
    }
    const calculated = blindMetrics(records);
    blind[name] = calculated;
    assert(Object.entries(calculated).every(([key, expected]) => near(reported[key], expected)), `${name} summary mismatch`);
  }
  const chronology = valuation.validation.chronology;
  assert(chronology.training_slugs.every((s: string) => (bySlug.get(s) as any).listed_at <= chronology.cutoff)
    && chronology.test_slugs.every((s: string) => (bySlug.get(s) as any).listed_at > chronology.cutoff), 'Listing dates cross holdout cutoff');
  assert(!chronology.training_slugs.some((s: string) => chronology.test_slugs.includes(s)), 'Train/test overlap');
  const intervals = valuation.intervals;
  const residuals = valuation.validation.loo_predictions.map((r: any) => r.residual);
  assert(near(q(residuals, 0.1), intervals.residual_p10) && near(q(residuals, 0.9), intervals.residual_p90), 'Residual quantile mismatch');
  assert(near(residuals.filter((r: number) => r >= intervals.residual_p10 && r <= intervals.residual_p90).length / residuals.length, intervals.calibration_coverage), 'Calibration coverage mismatch');
  const walkResiduals = valuation.validation.walk_forward_predictions.map((r: any) => r.residual);
  assert(near(walkResiduals.filter((r: number) => r >= intervals.walk_forward_residual_p10 && r <= intervals.walk_forward_residual_p90).length / walkResiduals.length, intervals.walk_forward_coverage), 'WF coverage mismatch');
  const outer = valuation.validation.nested_audit;
  assert(outer.training_slugs.every((s: string) => (bySlug.get(s) as any).listed_at <= outer.cutoff)
    && outer.test_slugs.every((s: string) => (bySlug.get(s) as any).listed_at > outer.cutoff), 'Outer seal chronology');
  assert(near(outer.predictions.filter((r: any) => r.residual >= outer.interval.residual_p10 && r.residual <= outer.interval.residual_p90).length / outer.test_n, outer.interval.coverage), 'Outer coverage mismatch');
  assert(valuation.bootstrap.refits === 200 && valuation.ablation.configurations.length === 32, 'Missing refits/ablation designs');
  for (const term of valuation.ablation.terms.filter((t: any) => t.retained)) {
    assert(term.with_term.loo.median_abs_log_error < term.without_term.loo.median_abs_log_error
      && term.with_term.walk_forward.median_abs_log_error < term.without_term.walk_forward.median_abs_log_error, `${term.term} retained despite failed blind test`);
  }
  check('blind metrics, temporal splits, ablation and interval coverage', true, blind);
} catch (error) { check('blind metrics, temporal splits, ablation and interval coverage', false, String(error)); }

const probabilityMetrics: any = {};
try {
  assert(oddsReport.cohort_n === snapshot.protocols.length && oddsReport.issued_n === snapshot.protocols.filter((p: any) => !pretoken(p)).length, 'Odds cohort omits labels');
  for (const name of ['loo', 'walk_forward']) {
    const ps = oddsReport.predictions[name];
    const n = ps.length;
    assert(new Set(ps.map((r: any) => r.slug)).size === n, `${name} duplicate odds predictions`);
    if (name === 'loo') assert(n === snapshot.protocols.length, 'Incomplete LOO odds cohort');
    const brier = (key: string) => ps.reduce((sum: number, r: any) => sum + (r[key] - Number(!pretoken(bySlug.get(r.slug)))) ** 2, 0) / n;
    const logLoss = (key: string) => -ps.reduce((sum: number, r: any) => {
      const y = Number(!pretoken(bySlug.get(r.slug))), p = Math.max(Number.EPSILON, Math.min(1 - Number.EPSILON, r[key]));
      return sum + y * Math.log(p) + (1 - y) * Math.log1p(-p);
    }, 0) / n;
    const result = { n, brier: brier('probability'), log_loss: logLoss('probability'), base_brier: brier('base_probability'), base_log_loss: logLoss('base_probability') };
    probabilityMetrics[name] = result;
    assert(Object.entries(result).every(([k, expected]) => near(oddsReport.validation[name][k], expected)), `${name} odds metrics mismatch`);
    for (const row of ps) {
      const source: any = bySlug.get(row.slug);
      assert(row.issued === Number(!pretoken(source)), `${row.slug} odds label mismatch`);
      if (name === 'loo') assert(near(row.base_probability, (oddsReport.issued_n - row.issued) / (snapshot.protocols.length - 1)), `${row.slug} baseline saw its own label`);
      else assert(source.listed_at > oddsReport.validation.walk_forward.cutoff, `${row.slug} precedes odds test cutoff`);
    }
  }
  check('odds Brier/log loss vs sealed labels', true, probabilityMetrics);
} catch (error) { check('odds Brier/log loss vs sealed labels', false, String(error)); }

for (const sample of samples) process.stdout.write(`RECALC ${JSON.stringify(sample)}\n`);
const report = { passed: checks.every(c => c.pass), snapshot_sha256: digest, checks, samples,
  blind_metrics: blind, odds_metrics: probabilityMetrics };
writeFileSync(resolve(root, 'out/verification.json'), JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`${report.passed ? 'PASS' : 'FAIL'} v2 independent verification (${checks.filter(c => c.pass).length}/${checks.length})\n`);
if (!report.passed) process.exitCode = 1;
