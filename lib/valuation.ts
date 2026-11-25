/** Snapshot-only valuation research. All calibrations are re-estimated inside every holdout. */
type Protocol = {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null; listed_at: string | null;
};
type Form = 'log-log line' | 'log-log quadratic' | 'category median';
type Term = 'category' | 'growth' | 'maturity' | 'multi_chain' | 'completeness';
type Calibration = { global: number; low: number; high: number; categories: Record<string, { n: number; median: number; clipped: number; multiplier: number }> };
type Fit = { form: Form; mask: number; center: number; coefficients: number[]; calibration: Calibration; n: number; r2: number };
type Heldout = { slug: string; name: string; category: string | null; listed_at: string | null; tvl_usd: number; mcap_usd: number; predicted_usd: number; predicted_ratio: number; actual_ratio: number; predicted_actual_ratio: number; log_error: number; residual: number };

const TERMS: Term[] = ['category', 'growth', 'maturity', 'multi_chain', 'completeness'];
const FORMS: Form[] = ['log-log line', 'log-log quadratic', 'category median'];
const BOOTSTRAP_REFITS = 200;
const DAY = 86_400_000;

function mean(values: number[]): number { return values.reduce((sum, n) => sum + n, 0) / values.length; }
function q(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) throw new Error('Cannot estimate a quantile from an empty sample');
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  return sorted[lower]! + (sorted[Math.ceil(position)]! - sorted[lower]!) * (position - lower);
}
function age(asOf: string, listed: string | null): number | null {
  if (!listed) return null;
  const days = (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listed}T00:00:00Z`)) / DAY;
  return Number.isFinite(days) ? Math.round(days) : null;
}
function active(mask: number): Term[] { return TERMS.filter((_, index) => (mask & (1 << index)) !== 0); }
function categoryName(p: Protocol): string { return p.category ?? 'Uncategorized'; }

/** The v1 calibration, including log quantiles, clipping and arithmetic n/(n+8) shrinkage. */
function calibrate(train: Protocol[]): Calibration {
  const logs = train.map(p => Math.log(p.mcap_usd! / p.tvl_usd));
  const global = Math.exp(q(logs, 0.5));
  const low = q(logs, 0.1);
  const high = q(logs, 0.9);
  const groups: Record<string, number[]> = {};
  train.forEach(p => (groups[categoryName(p)] ??= []).push(Math.log(p.mcap_usd! / p.tvl_usd)));
  const categories: Calibration['categories'] = {};
  for (const [category, values] of Object.entries(groups)) {
    const median = q(values, 0.5);
    const clipped = Math.max(low, Math.min(high, median));
    const weight = values.length / (values.length + 8);
    categories[category] = { n: values.length, median: Math.exp(median), clipped: Math.exp(clipped), multiplier: Math.exp(clipped) * weight + global * (1 - weight) };
  }
  return { global, low: Math.exp(low), high: Math.exp(high), categories };
}

/** These are the actual v1 shapes, with their actual constants; no surrogate features. */
function multipliers(p: Protocol, asOf: string, calibration: Calibration): Record<Term, number> {
  const days = age(asOf, p.listed_at);
  return {
    category: calibration.categories[categoryName(p)]?.multiplier ?? calibration.global,
    growth: p.change_7d === null ? 1 : Math.exp(0.22 * Math.tanh(p.change_7d / 25)),
    maturity: days === null ? 1 : 0.75 + 0.45 * (1 - Math.exp(-days / 180)) * Math.exp(-Math.max(0, days - 1095) / 1460),
    multi_chain: 1 + 0.07 * Math.log2(Math.min(8, Math.max(1, new Set(p.chains).size))),
    completeness: (p.change_7d === null ? 0.92 : 1) * (days === null ? 0.88 : 1) * (p.category === null ? 0.92 : 1),
  };
}
function offset(p: Protocol, asOf: string, fit: Pick<Fit, 'mask' | 'calibration'>): number {
  const values = multipliers(p, asOf, fit.calibration);
  return active(fit.mask).reduce((sum, term) => sum + Math.log(values[term]), 0);
}

/** Small least-squares system solved by pivoted Gauss-Jordan elimination. */
function solve(design: number[][], targets: number[]): number[] {
  const dimensions = design[0]!.length;
  const system = Array.from({ length: dimensions }, (_, a) => [
    ...Array.from({ length: dimensions }, (_, b) => design.reduce((sum, row) => sum + row[a]! * row[b]!, 0)),
    design.reduce((sum, row, index) => sum + row[a]! * targets[index]!, 0),
  ]);
  for (let column = 0; column < dimensions; column++) {
    let pivot = column;
    for (let row = column + 1; row < dimensions; row++) if (Math.abs(system[row]![column]!) > Math.abs(system[pivot]![column]!)) pivot = row;
    if (Math.abs(system[pivot]![column]!) < 1e-10) return [mean(targets), ...Array(dimensions - 1).fill(0)];
    [system[column], system[pivot]] = [system[pivot]!, system[column]!];
    const divisor = system[column]![column]!;
    for (let k = column; k <= dimensions; k++) system[column]![k]! /= divisor;
    for (let row = 0; row < dimensions; row++) {
      if (row === column) continue;
      const scale = system[row]![column]!;
      for (let k = column; k <= dimensions; k++) system[row]![k]! -= scale * system[column]![k]!;
    }
  }
  return system.map(row => row[dimensions]!);
}
function curveLog(p: Protocol, fit: Fit): number {
  const logTvl = Math.log(Math.max(1, p.tvl_usd));
  if (fit.form === 'category median') return logTvl + Math.log(fit.calibration.categories[categoryName(p)]?.multiplier ?? fit.calibration.global);
  const z = logTvl - fit.center;
  return fit.coefficients[0]! + fit.coefficients[1]! * z + (fit.coefficients[2] ?? 0) * z * z;
}
function predictLog(p: Protocol, fit: Fit, asOf: string): number { return curveLog(p, fit) + offset(p, asOf, fit); }

function fitModel(train: Protocol[], form: Form, mask: number, asOf: string): Fit {
  const calibration = calibrate(train);
  const center = mean(train.map(p => Math.log(p.tvl_usd)));
  const partial = { mask, calibration };
  const targets = train.map(p => Math.log(p.mcap_usd!) - offset(p, asOf, partial));
  const design = train.map(p => {
    const z = Math.log(p.tvl_usd) - center;
    return form === 'log-log quadratic' ? [1, z, z * z] : [1, z];
  });
  const coefficients = form === 'category median' ? [] : solve(design, targets);
  const fit: Fit = { form, mask, center, coefficients, calibration, n: train.length, r2: 0 };
  const targetMean = mean(train.map(p => Math.log(p.mcap_usd!)));
  const variance = train.reduce((sum, p) => sum + (Math.log(p.mcap_usd!) - targetMean) ** 2, 0);
  fit.r2 = 1 - train.reduce((sum, p) => sum + (Math.log(p.mcap_usd!) - predictLog(p, fit, asOf)) ** 2, 0) / variance;
  return fit;
}
function heldout(p: Protocol, fit: Fit, asOf: string): Heldout {
  const prediction = predictLog(p, fit, asOf);
  const actual = Math.log(p.mcap_usd!);
  return {
    slug: p.slug, name: p.name, category: p.category, listed_at: p.listed_at,
    tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd!, predicted_usd: Math.exp(prediction),
    predicted_ratio: Math.exp(prediction) / p.tvl_usd, actual_ratio: p.mcap_usd! / p.tvl_usd,
    predicted_actual_ratio: Math.exp(prediction - actual), log_error: prediction - actual, residual: actual - prediction,
  };
}
function metrics(rows: Heldout[]) {
  const errors = rows.map(row => Math.abs(row.log_error));
  return {
    n: rows.length,
    median_abs_log_error: q(errors, 0.5),
    median_error_factor: Math.exp(q(errors, 0.5)),
    mean_abs_log_error: mean(errors),
    median_predicted_actual_ratio: q(rows.map(row => row.predicted_actual_ratio), 0.5),
    within_2x: errors.filter(error => error <= Math.log(2)).length / rows.length,
  };
}
function leaveOneOut(pool: Protocol[], form: Form, mask: number, asOf: string): Heldout[] {
  return pool.map((p, index) => heldout(p, fitModel(pool.filter((_, other) => other !== index), form, mask, asOf), asOf));
}
function timeSplit(pool: Protocol[]) {
  const dated = pool.filter(p => p.listed_at !== null && Number.isFinite(Date.parse(p.listed_at!))).sort((a, b) => a.listed_at!.localeCompare(b.listed_at!) || a.slug.localeCompare(b.slug));
  const cutoff = dated[Math.floor(dated.length / 2) - 1]!.listed_at!;
  return { train: dated.filter(p => p.listed_at! <= cutoff), test: dated.filter(p => p.listed_at! > cutoff), cutoff, undated: pool.length - dated.length };
}
function score(pool: Protocol[], split: ReturnType<typeof timeSplit>, form: Form, mask: number, asOf: string) {
  const loo = leaveOneOut(pool, form, mask, asOf);
  const fitted = fitModel(split.train, form, mask, asOf);
  const walk = split.test.map(p => heldout(p, fitted, asOf));
  const looMetrics = metrics(loo);
  const walkMetrics = metrics(walk);
  return {
    mask, terms: active(mask), name: active(mask).join(' + ') || 'curve only',
    loo: looMetrics, walk_forward: walkMetrics,
    combined_log_score: looMetrics.median_abs_log_error + walkMetrics.median_abs_log_error,
    loo_rows: loo, walk_forward_rows: walk,
  };
}
function bothImprove(a: ReturnType<typeof score>, b: ReturnType<typeof score>): boolean {
  return a.loo.median_abs_log_error < b.loo.median_abs_log_error - 1e-12
    && a.walk_forward.median_abs_log_error < b.walk_forward.median_abs_log_error - 1e-12;
}
function compactScore(s: ReturnType<typeof score>) {
  return { mask: s.mask, terms: s.terms, name: s.name, loo: s.loo, walk_forward: s.walk_forward, combined_log_score: s.combined_log_score };
}
function seedFrom(text: string): number {
  let state = 2166136261;
  for (const character of text) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  return state || 1;
}
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}
function valueNumber(logValue: number): number {
  const value = Math.exp(logValue);
  if (!Number.isFinite(value) || value <= 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error(`Valuation outside safe numeric range: ${value}`);
  return Math.max(1, Math.round(value));
}
function equation(fit: Fit): string {
  const names = active(fit.mask);
  const base = fit.form === 'category median'
    ? 'log(TVL) + log(train-only shrunk category multiple)'
    : `${fit.coefficients[0]} + ${fit.coefficients[1]} × (log(TVL) − ${fit.center})${fit.form === 'log-log quadratic' ? ` + ${fit.coefficients[2]} × (log(TVL) − ${fit.center})²` : ''}`;
  return `log(implied market cap) = ${base}${names.length ? ` + ${names.map(name => `log(${name})`).join(' + ')}` : ''}`;
}

function selectDesign(pool: Protocol[], asOf: string) {
  const split = timeSplit(pool);
  const formScores = FORMS.map(form => ({ form, ...score(pool, split, form, 0, asOf) }));
  const formWinner = [...formScores].sort((a, b) => a.combined_log_score - b.combined_log_score || FORMS.indexOf(a.form) - FORMS.indexOf(b.form))[0]!;
  // If category medians win, still test all five legacy terms on a fitted curve. This avoids
  // applying the same category calibration twice. The two eligible final designs compete.
  const ablationForm = formWinner.form === 'category median'
    ? [...formScores].filter(row => row.form !== 'category median').sort((a, b) => a.combined_log_score - b.combined_log_score)[0]!.form : formWinner.form;
  const all = Array.from({ length: 1 << TERMS.length }, (_, mask) => score(pool, split, ablationForm, mask, asOf));
  const eligible = all.filter(candidate => candidate.terms.every(term => bothImprove(candidate, all[candidate.mask & ~(1 << TERMS.indexOf(term))]!)));
  const qualified = eligible.filter(candidate => candidate.mask === 0 || bothImprove(candidate, all[0]!));
  const ablationWinner = [...qualified].sort((a, b) => a.combined_log_score - b.combined_log_score || a.terms.length - b.terms.length || a.mask - b.mask)[0]!;
  const useMedian = formWinner.form === 'category median' && formWinner.combined_log_score <= ablationWinner.combined_log_score;
  return { split, formScores, ablationForm, all, qualified, useMedian,
    chosenForm: useMedian ? formWinner.form : ablationForm,
    chosen: useMedian ? formWinner : ablationWinner,
    mask: useMedian ? 0 : ablationWinner.mask };
}

function outerAudit(pool: Protocol[], asOf: string) {
  const dated = pool.filter(p => p.listed_at !== null && Number.isFinite(Date.parse(p.listed_at!))).sort((a, b) => a.listed_at!.localeCompare(b.listed_at!) || a.slug.localeCompare(b.slug));
  const cutoff = dated[Math.floor(dated.length * 0.75) - 1]!.listed_at!;
  const train = dated.filter(p => p.listed_at! <= cutoff);
  const test = dated.filter(p => p.listed_at! > cutoff);
  const inner = selectDesign(train, asOf);
  const fitted = fitModel(train, inner.chosenForm, inner.mask, asOf);
  const predictions = test.map(p => heldout(p, fitted, asOf));
  const residuals = leaveOneOut(train, inner.chosenForm, inner.mask, asOf).map(row => row.residual);
  const lower = q(residuals, 0.1);
  const upper = q(residuals, 0.9);
  return {
    method: 'Seal the newest 25% of dated comparable protocols. Select the curve and all 32 legacy-term subsets using ONLY older protocols (inner LOO plus inner listing-date walk-forward); fit on that older pool and score the untouched newer pool once. Undated comparables participate in neither outer training nor outer testing.',
    train_n: train.length, test_n: test.length, cutoff, first_test_date: test[0]!.listed_at,
    undated_excluded: pool.length - dated.length,
    selected: { form: inner.chosenForm, terms: active(inner.mask), mask: inner.mask, equation: equation(fitted) },
    inner_loo: inner.chosen.loo, inner_walk_forward: inner.chosen.walk_forward,
    inner_curves: inner.formScores.map(row => ({ form: row.form, ...compactScore(row) })),
    inner_configurations: inner.all.map(row => ({ ...compactScore(row), eligible: inner.qualified.includes(row), chosen: row.mask === inner.mask })),
    metrics: metrics(predictions), predictions,
    interval: { residual_p10: lower, residual_p90: upper, calibration_n: residuals.length,
      coverage: predictions.filter(row => row.residual >= lower && row.residual <= upper).length / predictions.length },
    training_slugs: train.map(p => p.slug), test_slugs: test.map(p => p.slug),
    limitation: 'Selection never sees the outer test outcomes. The audit remains a contemporaneous listing-cohort stress test; it is not a historical backtest or a future launch forecast. Its selected design may differ from the final full-pool design.',
  };
}

export function buildValuation(snapshot: { as_of: string; protocols: Protocol[] }, selected: Protocol[]): { rows: Record<string, any>; report: any } {
  const pool = snapshot.protocols.filter(p => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== null);
  if (pool.length < 12) throw new Error('Insufficient positive market-cap/TVL comparables');
  const { split, formScores, ablationForm, all, qualified, useMedian, chosenForm, chosen, mask } = selectDesign(pool, snapshot.as_of);
  const fit = fitModel(pool, chosenForm, mask, snapshot.as_of);
  const loo = chosen.loo_rows;
  const walk = chosen.walk_forward_rows;
  const lowResidual = q(loo.map(row => row.residual), 0.1);
  const highResidual = q(loo.map(row => row.residual), 0.9);

  // Walk-forward interval calibration only sees the older training protocols, even for its
  // residual quantiles. This is separate from the full-sample interval printed on each row.
  const trainResiduals = leaveOneOut(split.train, chosenForm, mask, snapshot.as_of).map(row => row.residual);
  const timeLow = q(trainResiduals, 0.1);
  const timeHigh = q(trainResiduals, 0.9);
  const timeCoverage = walk.filter(row => row.residual >= timeLow && row.residual <= timeHigh).length / walk.length;

  const seed = seedFrom(snapshot.as_of + '|' + pool.map(p => `${p.slug}:${p.tvl_usd}:${p.mcap_usd}`).join('|'));
  const random = generator(seed);
  const bootstrapValues: Record<string, number[]> = {};
  const bootstrapRanks: Record<string, number[]> = {};
  selected.forEach(p => { bootstrapValues[p.slug] = []; bootstrapRanks[p.slug] = []; });
  for (let replicate = 0; replicate < BOOTSTRAP_REFITS; replicate++) {
    const resample = Array.from({ length: pool.length }, () => pool[Math.floor(random() * pool.length)]!);
    const resampledFit = fitModel(resample, chosenForm, mask, snapshot.as_of);
    const predictions = selected.map(p => ({ slug: p.slug, value: valueNumber(predictLog(p, resampledFit, snapshot.as_of)) })).sort((a, b) => b.value - a.value || a.slug.localeCompare(b.slug));
    predictions.forEach((p, index) => { bootstrapValues[p.slug]!.push(p.value); bootstrapRanks[p.slug]!.push(index + 1); });
  }

  const rows: Record<string, any> = {};
  for (const p of selected) {
    const logValue = predictLog(p, fit, snapshot.as_of);
    const raw = multipliers(p, snapshot.as_of, fit.calibration);
    const comparable = [...pool].sort((a, b) => Number(b.category === p.category) - Number(a.category === p.category)
      || Math.abs(Math.log(a.tvl_usd / Math.max(1, p.tvl_usd))) - Math.abs(Math.log(b.tvl_usd / Math.max(1, p.tvl_usd))) || a.slug.localeCompare(b.slug)).slice(0, 3);
    rows[p.slug] = {
      implied_value_usd: valueNumber(logValue),
      implied_p10_usd: valueNumber(logValue + lowResidual),
      implied_p90_usd: valueNumber(logValue + highResidual),
      bootstrap_p10_usd: Math.round(q(bootstrapValues[p.slug]!, 0.1)),
      bootstrap_p90_usd: Math.round(q(bootstrapValues[p.slug]!, 0.9)),
      rank_p10: Math.max(1, Math.floor(q(bootstrapRanks[p.slug]!, 0.1))),
      rank_p90: Math.min(selected.length, Math.ceil(q(bootstrapRanks[p.slug]!, 0.9))),
      valuation_details: {
        form: chosenForm, equation: equation(fit), log_tvl: Math.log(Math.max(1, p.tvl_usd)),
        curve_log_value: curveLog(p, fit), applied_log_offset: offset(p, snapshot.as_of, fit),
        predicted_log_value: logValue, predicted_multiple: Math.exp(logValue) / Math.max(1, p.tvl_usd),
        multipliers: Object.fromEntries(TERMS.map(term => [term, { raw: raw[term], applied: active(mask).includes(term) ? raw[term] : 1, retained: active(mask).includes(term) }])),
        category_calibration: fit.calibration.categories[categoryName(p)] ?? null,
        predictive_interval: { residual_p10: lowResidual, residual_p90: highResidual, method: 'Full-pool leave-one-out log(mcap/TVL) residual quantiles; includes comparable dispersion' },
        comparables: comparable.map(comp => ({ slug: comp.slug, name: comp.name, category: comp.category, tvl_usd: comp.tvl_usd, mcap_usd: comp.mcap_usd, multiple: comp.mcap_usd! / comp.tvl_usd, same_category: comp.category === p.category })),
      },
    };
  }

  const terms = TERMS.map((term, index) => {
    const bit = 1 << index;
    const retained = !useMedian && (mask & bit) !== 0;
    const withTerm = all[retained ? mask : mask | bit]!;
    const withoutTerm = all[retained ? mask & ~bit : mask]!;
    const passes = bothImprove(withTerm, withoutTerm);
    const reason = retained
      ? 'Retained: lower median absolute log-ratio error in BOTH LOO and walk-forward against paired removal.'
      : useMedian ? 'The selected category-median form replaces legacy post-fit multipliers; this term was tested on the best fitted curve.'
        : !passes ? `Rejected: ${withTerm.loo.median_abs_log_error >= withoutTerm.loo.median_abs_log_error ? 'LOO does not improve' : 'LOO improves'}; ${withTerm.walk_forward.median_abs_log_error >= withoutTerm.walk_forward.median_abs_log_error ? 'walk-forward does not improve' : 'walk-forward improves'}.`
          : 'Rejected: its augmented subset fails the all-terms paired-removal rule or has a worse combined score than the selected eligible subset.';
    const evidenceIndices = [0, Math.floor(pool.length / 2), pool.length - 1];
    const evidence = evidenceIndices.map(index => ({ with_term: withTerm.loo_rows[index], without_term: withoutTerm.loo_rows[index] }));
    return { term, retained, passes_both: passes, with_term: compactScore(withTerm), without_term: compactScore(withoutTerm), evidence, reason };
  });
  const byCategory = [...new Set(pool.map(categoryName))].sort().map(category => {
    const group = loo.filter(row => (row.category ?? 'Uncategorized') === category);
    return { category, ...metrics(group) };
  });

  return { rows, report: {
    sample_count: pool.length,
    sample_rule: 'Positive observed market cap, positive TVL, recorded category. No tokenless protocol participates in the valuation fit.',
    selected: { form: chosenForm, terms: active(mask), mask, equation: equation(fit) },
    fit: { form: fit.form, n: fit.n, center_log_tvl: fit.center, coefficients: fit.coefficients, r2_log_mcap: fit.r2, category_calibration: fit.calibration },
    curves: formScores.map(row => ({ form: row.form, chosen: row.form === chosenForm, ...compactScore(row) })),
    ablation: {
      form: ablationForm, tested_configurations: all.length,
      rule: 'Evaluate all 32 exact-v1 term subsets. Each retained term must reduce median absolute log error in BOTH LOO and chronological holdout against paired removal; the subset must also beat curve only in BOTH tests. Choose the lowest summed log error among eligible subsets. Coefficients of legacy log multipliers are fixed to 1; re-fit the base curve to log(mcap) minus their offsets.',
      terms,
      configurations: all.map(row => ({ ...compactScore(row), eligible: qualified.includes(row), chosen: !useMedian && row.mask === mask })),
      legacy_shapes: {
        category: 'Median log(mcap/TVL) by category; clip to training global P10–P90; arithmetic shrink exp(clipped) × n/(n+8) + exp(global median) × 8/(n+8).',
        growth: 'Missing → 1; otherwise exp(0.22 × tanh(change_7d/25)).',
        maturity: 'Missing age → 1; otherwise 0.75 + 0.45 × (1 − exp(−days/180)) × exp(−max(0,days−1095)/1460).',
        multi_chain: '1 + 0.07 × log2(min(8,max(1,unique chain count))).',
        completeness: 'Multiply 0.92 when growth missing, 0.88 when listing date missing, 0.92 when category missing.',
      },
    },
    validation: {
      metric: 'Error factor = exp(median(abs(log(predicted mcap/TVL ÷ observed mcap/TVL)))); 1× is perfect. Signed predicted/actual ratio is also reported.',
      loo: metrics(loo), walk_forward: metrics(walk),
      chronology: { train_n: split.train.length, test_n: split.test.length, cutoff: split.cutoff, first_test_date: split.test[0]!.listed_at, undated_excluded: split.undated, training_slugs: split.train.map(p => p.slug), test_slugs: split.test.map(p => p.slug) },
      by_category: byCategory, loo_predictions: loo, walk_forward_predictions: walk,
      nested_audit: outerAudit(pool, snapshot.as_of),
    },
    intervals: {
      method: 'Asymmetric P10–P90 quantiles of leave-one-out residual log(observed mcap/TVL) − log(predicted mcap/TVL). Predictive range includes cross-protocol residual dispersion, separately from bootstrap parameter uncertainty.',
      target_coverage: 0.8, calibration_n: loo.length, residual_p10: lowResidual, residual_p90: highResidual,
      calibration_coverage: loo.filter(row => row.residual >= lowResidual && row.residual <= highResidual).length / loo.length,
      walk_forward_coverage: timeCoverage, walk_forward_n: walk.length,
      walk_forward_calibration_n: trainResiduals.length, walk_forward_residual_p10: timeLow, walk_forward_residual_p90: timeHigh,
      coverage_note: 'Calibration coverage is descriptive. Chronological coverage uses residual quantiles recalibrated only on older training protocols; model/term selection still reuses these holdouts, so this is a selection diagnostic, not an untouched guarantee.',
    },
    bootstrap: { refits: BOOTSTRAP_REFITS, seed, method: 'Protocol pairs sampled with replacement; re-fit every coefficient and category calibration, re-value and re-rank all selected rows. Form and retained subset are held fixed. Percentiles use linear interpolation; rank endpoints round outward.', interpretation: 'Bootstrap ranges describe parameter and rank stability conditional on the chosen design. They exclude individual-protocol residual noise; the separate predictive P10–P90 range includes that noise.' },
    limitations: [
      'Snapshot fields are contemporaneous. listed_at is a protocol listing date, not its token launch date. The chronological split is a listing-cohort stress test, not a historical price backtest.',
      'Primary LOO and walk-forward scores are reused for design selection and can be optimistic. The separate outer audit reserves the newest dated cohort before all model selection; no independent historical test is available.',
      'Observed market capitalization is used, not fully diluted valuation; token supply and allocation data are absent.',
      'A fitted comparable value is conditional on a token existing and says nothing by itself about whether a protocol will distribute an airdrop.',
    ],
  } };
}
