// Cross-sectional token prevalence, estimated only from the sealed snapshot.
// This is a scenario probability; the input has no token launch dates or future outcomes.

interface Observation {
  slug: string;
  category: string;
  age: number | null;
  tvl: number;
  issued: number;
  listed_at: string | null;
}

interface Count {
  n: number;
  issued: number;
}

interface OddsTable {
  n: number;
  issued: number;
  global_rate: number;
  age_cuts: number[];
  tvl_cut: number;
  parent_strength: number;
  cell_strength: number;
  parents: Map<string, Count>;
  cells: Map<string, Count>;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const a = [...values].sort((x, y) => x - y);
  const at = (a.length - 1) * q;
  const lo = Math.floor(at);
  return a[lo]! + (a[Math.ceil(at)]! - a[lo]!) * (at - lo);
}

function observations(snapshot: any): Observation[] {
  const asOf = Date.parse(`${snapshot.as_of}T00:00:00Z`);
  return snapshot.protocols.map((p: any) => {
    const listed = p.listed_at === null ? NaN : Date.parse(`${p.listed_at}T00:00:00Z`);
    return {
      slug: p.slug,
      category: p.category ?? 'Uncategorized',
      age: Number.isFinite(listed) && Number.isFinite(asOf)
        ? Math.max(0, Math.floor((asOf - listed) / 86_400_000)) : null,
      tvl: p.tvl_usd,
      issued: Number(p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null),
      listed_at: Number.isFinite(listed) ? p.listed_at : null,
    };
  });
}

function bands(row: Observation, table: OddsTable) {
  const ageIndex = row.age === null ? -1 : row.age <= table.age_cuts[0]! ? 0
    : row.age <= table.age_cuts[1]! ? 1 : 2;
  const ageBand = ageIndex < 0 ? 'Unknown age' : `Age tercile ${ageIndex + 1}`;
  const tvlBand = row.tvl <= table.tvl_cut ? 'TVL at/below median' : 'TVL above median';
  const parent = `${ageBand} | ${tvlBand}`;
  return { ageBand, tvlBand, parent, cell: `${row.category} | ${parent}` };
}

function addCount(map: Map<string, Count>, key: string, issued: number) {
  const value = map.get(key) ?? { n: 0, issued: 0 };
  value.n++;
  value.issued += issued;
  map.set(key, value);
}

function fit(rows: Observation[]): OddsTable {
  if (rows.length === 0) throw new Error('Token prevalence needs a nonempty training cohort');
  const ages = rows.flatMap((r) => r.age === null ? [] : [r.age]);
  const table: OddsTable = {
    n: rows.length,
    issued: rows.reduce((sum, r) => sum + r.issued, 0),
    global_rate: 0,
    // Age is recorded in whole days; whole-day quantiles avoid displaying a
    // rounded threshold that differs from the comparison at a floating edge.
    age_cuts: [Math.round(quantile(ages, 1 / 3)), Math.round(quantile(ages, 2 / 3))],
    tvl_cut: quantile(rows.map((r) => r.tvl), 1 / 2),
    parent_strength: Math.sqrt(rows.length),
    cell_strength: 0,
    parents: new Map(),
    cells: new Map(),
  };
  table.global_rate = table.issued / table.n;
  for (const row of rows) {
    const keys = bands(row, table);
    addCount(table.parents, keys.parent, row.issued);
    addCount(table.cells, keys.cell, row.issued);
  }
  // Both prior weights derive from training sample support. No observed outcome
  // is used to tune cutpoints or prior strengths on a held-out protocol.
  table.cell_strength = Math.sqrt(quantile([...table.parents.values()].map((p) => p.n), 1 / 2));
  return table;
}

function predict(row: Observation, table: OddsTable) {
  const keys = bands(row, table);
  const parent = table.parents.get(keys.parent) ?? { n: 0, issued: 0 };
  const cell = table.cells.get(keys.cell) ?? { n: 0, issued: 0 };
  const prior = (parent.issued + table.parent_strength * table.global_rate)
    / (parent.n + table.parent_strength);
  const probability = (cell.issued + table.cell_strength * prior) / (cell.n + table.cell_strength);
  return {
    probability,
    cell: keys.cell,
    age_band: keys.ageBand,
    tvl_band: keys.tvlBand,
    cell_n: cell.n,
    cell_issued: cell.issued,
    prior_rate: prior,
    prior_strength: table.cell_strength,
    parent_n: parent.n,
    parent_issued: parent.issued,
    parent_prior_strength: table.parent_strength,
    global_n: table.n,
    global_issued: table.issued,
    global_rate: table.global_rate,
    age_cutpoints_days: table.age_cuts,
    tvl_cutpoint_usd: table.tvl_cut,
    formula: 'p=(cell_issued + prior_strength × prior_rate)/(cell_n + prior_strength); prior_rate=(parent_issued + sqrt(training_n) × global_rate)/(parent_n + sqrt(training_n))',
  };
}

function metrics(predictions: number[], outcomes: number[], baselines: number[]) {
  const count = predictions.length;
  if (count === 0) return { n: 0, brier: null, log_loss: null, base_brier: null, base_log_loss: null };
  const brier = (ps: number[]) => ps.reduce((sum, p, i) => sum + (p - outcomes[i]!) ** 2, 0) / count;
  // Numeric clipping only affects log(0) in degenerate training cohorts.
  const loss = (ps: number[]) => -ps.reduce((sum, p, i) => {
    const bounded = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, p));
    return sum + outcomes[i]! * Math.log(bounded) + (1 - outcomes[i]!) * Math.log1p(-bounded);
  }, 0) / count;
  return {
    n: count,
    brier: brier(predictions),
    log_loss: loss(predictions),
    base_brier: brier(baselines),
    base_log_loss: loss(baselines),
    mean_probability: predictions.reduce((a, b) => a + b, 0) / count,
    observed_rate: outcomes.reduce((a, b) => a + b, 0) / count,
  };
}

/** All fits, cutpoints, prior counts and baselines are recomputed inside each holdout. */
export function buildOdds(snapshot: any, selected: any[]) {
  const cohort = observations(snapshot);
  const full = fit(cohort);
  const selectedSlugs = new Set(selected.map((r) => r.slug));
  const rows: Record<string, any> = {};
  const probabilities: number[] = [];
  const outcomes: number[] = [];
  const bases: number[] = [];
  const validationRows: any[] = [];
  for (let index = 0; index < cohort.length; index++) {
    const held = cohort[index]!;
    const trained = fit(cohort.filter((_, i) => i !== index));
    const odds = predict(held, trained);
    probabilities.push(odds.probability);
    outcomes.push(held.issued);
    bases.push(trained.global_rate);
    validationRows.push({ slug: held.slug, issued: held.issued, probability: odds.probability, base_probability: trained.global_rate });
    if (selectedSlugs.has(held.slug)) {
      rows[held.slug] = {
        token_probability: odds.probability,
        odds: { ...odds, excluded_target: true, training_n: trained.n },
      };
    }
  }
  if (Object.keys(rows).length !== selectedSlugs.size) throw new Error('A selected row is absent from the odds cohort');

  const dated = cohort.filter((r) => r.listed_at !== null)
    .sort((a, b) => a.listed_at!.localeCompare(b.listed_at!) || a.slug.localeCompare(b.slug));
  const cutoff = dated.length > 1 ? dated[Math.floor((dated.length - 1) / 2)]!.listed_at : null;
  const train = cutoff === null ? [] : dated.filter((r) => r.listed_at! <= cutoff);
  const test = cutoff === null ? [] : dated.filter((r) => r.listed_at! > cutoff);
  let walkForward: any = {
    ...metrics([], [], []), train_n: train.length, test_n: test.length,
    cutoff, undated_excluded: cohort.length - dated.length,
    method: 'Earlier listing cohorts train; later cohorts test; date ties stay in the same cohort.',
  };
  let walkForwardRows: any[] = [];
  if (train.length > 0 && test.length > 0) {
    const table = fit(train);
    walkForwardRows = test.map((r) => ({
      slug: r.slug, issued: r.issued, probability: predict(r, table).probability,
      base_probability: table.global_rate,
    }));
    walkForward = {
      ...walkForward,
      ...metrics(walkForwardRows.map((r) => r.probability), walkForwardRows.map((r) => r.issued), walkForwardRows.map((r) => r.base_probability)),
      train_issued: table.issued,
      test_issued: test.reduce((s, r) => s + r.issued, 0),
      age_cutpoints_days: table.age_cuts,
      tvl_cutpoint_usd: table.tvl_cut,
    };
  }

  const buckets = [...full.cells.entries()].map(([cell, count]) => {
    const exemplar = cohort.find((r) => bands(r, full).cell === cell)!;
    const estimate = predict(exemplar, full);
    return { cell, n: count.n, issued: count.issued, rate: estimate.probability, prior_rate: estimate.prior_rate };
  }).sort((a, b) => b.n - a.n || a.cell.localeCompare(b.cell));
  const missing = cohort.filter((r) => r.age === null);
  const report = {
    method: 'Hierarchical empirical token prevalence: category × age tercile × TVL half. Age terciles and the TVL median use training records only; unknown age has its own bucket. Age/TVL parent rates shrink toward the global issued rate; category cells shrink toward their age/TVL parent.',
    caveat: 'This is the share of comparable surviving snapshot protocols that already have a token, used only as a launch scenario weight. The snapshot contains listing dates, not token launch dates, historical observations or future outcomes. It cannot estimate a future launch hazard, a deadline or a probability conditional on still being tokenless. Listing-cohort validation is a cross-sectional stress test, not a historical backtest.',
    cohort_n: full.n,
    issued_n: full.issued,
    pretoken_n: full.n - full.issued,
    global_rate: full.global_rate,
    age_cutpoints_days: full.age_cuts,
    tvl_cutpoints_usd: [full.tvl_cut],
    prior_strength: full.cell_strength,
    parent_prior_strength: full.parent_strength,
    strength_method: 'Parent prior strength = sqrt(training protocol count). Category-cell prior strength = sqrt(median populated age/TVL parent count). Both are recomputed within every holdout.',
    formula: 'global_rate=issued/training_n; parent_rate=(parent_issued+sqrt(training_n)×global_rate)/(parent_n+sqrt(training_n)); p=(cell_issued+cell_strength×parent_rate)/(cell_n+cell_strength).',
    target_exclusion: 'Every board probability refits the complete table without that protocol. Its known tokenless label never supplies its own evidence; per-row counts, cutpoints and prior strengths can therefore differ from this full-cohort table.',
    missing_age: { n: missing.length, issued: missing.reduce((sum, r) => sum + r.issued, 0) },
    buckets,
    validation: { loo: metrics(probabilities, outcomes, bases), walk_forward: walkForward },
    predictions: { loo: validationRows, walk_forward: walkForwardRows },
  };
  return { rows, report };
}
