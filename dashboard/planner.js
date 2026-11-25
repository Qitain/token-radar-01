/* Pure deterministic budget planner; shared by the browser and the verification script. */
(function () {
  'use strict';
  const nonnegative = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  function scenario(row, options = {}) {
    const farm = row.farm;
    if (!farm) return null;
    const scale = options.payoutScale === undefined ? 1 : nonnegative(options.payoutScale);
    const timeValue = options.timeValue === undefined
      ? (farm.time_hours > 0 ? farm.time_cost_usd / farm.time_hours : 0)
      : nonnegative(options.timeValue);
    const timeCost = farm.time_hours * timeValue;
    const cost = farm.gas_usd + timeCost;
    const expected = farm.expected_airdrop_usd * scale;
    const low = farm.p10_airdrop_usd * scale;
    const net = expected - cost;
    const lowNet = low - cost;
    return {
      verdict: lowNet < 0 ? 'SKIP' : lowNet < cost ? 'THIN' : 'FARM',
      capital_usd: farm.capital_usd, gas_usd: farm.gas_usd, reserve_usd: farm.reserve_usd,
      weekly_hours: farm.weekly_hours, time_hours: farm.time_hours, time_cost_usd: timeCost,
      total_cost_usd: cost, expected_airdrop_usd: expected, p10_airdrop_usd: low,
      net_usd: net, p10_net_usd: lowNet, net_per_hour: farm.time_hours > 0 ? net / farm.time_hours : 0,
      p10_net_per_hour: farm.time_hours > 0 ? lowNet / farm.time_hours : 0,
      farmer_share: farm.farmer_share * scale,
      score: farm.reserve_usd > 0 ? expected / farm.reserve_usd : 0,
    };
  }

  // Every state is immutable. A linked choice history reconstructs an actual 0/1
  // subset; no mutable DP predecessor can accidentally reuse the same position.
  const EPSILON = 1e-9;
  const emptyState = () => ({ cash: 0, hours: 0, value: 0, count: 0, history: null });
  function extend(state, item, index) {
    return {
      cash: state.cash + item.scenario.reserve_usd,
      hours: state.hours + item.scenario.weekly_hours,
      value: state.value + item.scenario.expected_airdrop_usd,
      count: state.count + 1,
      history: { index, previous: state.history },
    };
  }
  function indices(state) {
    const result = [];
    for (let link = state.history; link; link = link.previous) result.push(link.index);
    return result;
  }
  function better(a, b) {
    return a.value > b.value || (a.value === b.value && (a.cash < b.cash
      || (a.cash === b.cash && (a.hours < b.hours || (a.hours === b.hours && a.count < b.count)))));
  }
  function bestState(frontier) {
    return frontier.reduce((best, state) => better(state, best) ? state : best, emptyState());
  }

  // Both frontiers are already sorted by cost with strictly increasing value.
  // Merge exclusion and inclusion states, keeping only nondominated outcomes.
  // A dominated state can never beat its dominator after the same future choices.
  function mergeCashFrontiers(existing, source, item, index, budget) {
    const result = [];
    let oldAt = 0, newAt = 0, bestValue = -Infinity;
    while (oldAt < existing.length || newAt < source.length) {
      const old = existing[oldAt];
      const base = source[newAt];
      const newCash = base ? base.cash + item.scenario.reserve_usd : Infinity;
      if (newCash > budget + EPSILON) newAt = source.length;
      let candidate;
      if (old && (newAt >= source.length || old.cash < newCash)) {
        candidate = old; oldAt++;
      } else if (newAt < source.length && (!old || newCash < old.cash)) {
        candidate = extend(base, item, index); newAt++;
      } else if (old && newAt < source.length) {
        // Equal cash: exclusion wins an exact value tie, preserving the earlier
        // density/rank ordering without inventing tiny preference bonuses.
        const value = base.value + item.scenario.expected_airdrop_usd;
        candidate = value > old.value ? extend(base, item, index) : old;
        oldAt++; newAt++;
      } else break;
      if (candidate.value > bestValue) {
        result.push(candidate); bestValue = candidate.value;
      }
    }
    return result;
  }

  function optimizeUniform(items, budget, hours) {
    const weekly = items[0].scenario.weekly_hours;
    const limit = weekly > 0 ? Math.min(items.length, Math.floor((hours + EPSILON) / weekly)) : items.length;
    if (limit === 0) return emptyState();
    const totalCash = items.reduce((sum, item) => sum + item.scenario.reserve_usd, 0);
    if (limit === items.length && totalCash <= budget + EPSILON) {
      return items.reduce((state, item, index) => extend(state, item, index), emptyState());
    }

    // First obtain an exact upper bound by dropping the time constraint. If
    // that optimal subset fits time, it also proves optimality under both limits.
    let unconstrained = [emptyState()];
    items.forEach((item, index) => {
      unconstrained = mergeCashFrontiers(unconstrained, unconstrained, item, index, budget);
    });
    const upper = bestState(unconstrained);
    if (upper.count <= limit) return upper;

    // Equal weekly times turn the second budget into an exact cardinality cap.
    // Process counts downward so each item can occur at most once. Costs and
    // payouts stay at their original precision; no budget discretization occurs.
    const frontiers = Array.from({ length: limit + 1 }, () => []);
    frontiers[0] = [emptyState()];
    items.forEach((item, index) => {
      for (let count = Math.min(limit, index + 1); count >= 1; count--) {
        frontiers[count] = mergeCashFrontiers(frontiers[count], frontiers[count - 1], item, index, budget);
      }
    });
    let best = emptyState();
    frontiers.forEach(frontier => { const candidate = bestState(frontier); if (better(candidate, best)) best = candidate; });
    return best;
  }

  // Exact fallback for positions with different weekly times. Sort by cash,
  // then use a Fenwick maximum over time to remove every state dominated in
  // cash, time and expected payout. General 0/1 two-budget selection can have
  // exponentially many nondominated states; the sealed 200-row model has equal
  // times and uses the faster cardinality solver above. There is no heuristic
  // fallback or silent loss of optimality.
  function paretoPrune(states) {
    states.sort((a, b) => a.cash - b.cash || a.hours - b.hours || b.value - a.value || a.count - b.count);
    const times = [...new Set(states.map(state => state.hours))].sort((a, b) => a - b);
    const timeIndex = new Map(times.map((time, index) => [time, index + 1]));
    const maxima = new Float64Array(times.length + 1).fill(-Infinity);
    const kept = [];
    for (const state of states) {
      const index = timeIndex.get(state.hours);
      let maximum = -Infinity;
      for (let at = index; at > 0; at -= at & -at) maximum = Math.max(maximum, maxima[at]);
      if (maximum >= state.value) continue;
      kept.push(state);
      for (let at = index; at < maxima.length; at += at & -at) maxima[at] = Math.max(maxima[at], state.value);
    }
    return kept;
  }
  function optimizeGeneral(items, budget, hours) {
    let frontier = [emptyState()];
    items.forEach((item, index) => {
      const additions = [];
      for (const state of frontier) {
        if (state.cash + item.scenario.reserve_usd <= budget + EPSILON
          && state.hours + item.scenario.weekly_hours <= hours + EPSILON) additions.push(extend(state, item, index));
      }
      frontier = paretoPrune([...frontier, ...additions]);
    });
    return bestState(frontier);
  }

  function plan(rows, options = {}) {
    const budget = nonnegative(options.budget);
    const hours = nonnegative(options.weeklyHours);
    const candidates = rows.map(row => ({ row, scenario: scenario(row, options) }))
      .filter(item => item.scenario && item.scenario.verdict !== 'SKIP'
        && Number.isFinite(item.scenario.expected_airdrop_usd) && item.scenario.expected_airdrop_usd >= 0
        && Number.isFinite(item.scenario.reserve_usd) && item.scenario.reserve_usd >= 0
        && Number.isFinite(item.scenario.weekly_hours) && item.scenario.weekly_hours >= 0)
      .sort((a, b) => b.scenario.score - a.scenario.score || a.row.rank - b.row.rank || a.row.slug.localeCompare(b.row.slug));
    const keys = ['capital_usd','gas_usd','reserve_usd','weekly_hours','time_hours','time_cost_usd','total_cost_usd','expected_airdrop_usd','p10_airdrop_usd','net_usd','p10_net_usd'];
    const totals = Object.fromEntries(keys.map(key => [key, 0]));
    const feasible = candidates.filter(item => item.scenario.reserve_usd <= budget + EPSILON && item.scenario.weekly_hours <= hours + EPSILON);
    const uniform = feasible.every(item => item.scenario.weekly_hours === feasible[0]?.scenario.weekly_hours);
    const optimum = feasible.length ? (uniform ? optimizeUniform(feasible, budget, hours) : optimizeGeneral(feasible, budget, hours)) : emptyState();
    const chosen = new Set(indices(optimum));
    const selected = feasible.filter((_, index) => chosen.has(index));
    selected.forEach(item => keys.forEach(key => { totals[key] += item.scenario[key]; }));
    totals.net_per_hour = totals.time_hours > 0 ? totals.net_usd / totals.time_hours : 0;
    totals.p10_net_per_hour = totals.time_hours > 0 ? totals.p10_net_usd / totals.time_hours : 0;
    return { selected, totals, eligible_count: candidates.length, skipped_count: rows.length - candidates.length, unused_budget: Math.max(0, budget - totals.reserve_usd), unused_weekly_hours: Math.max(0, hours - totals.weekly_hours), optimizer: 'Exact 0/1 subset: maximize total expected payout subject to reserve and weekly-time budgets; selected rows displayed by payout/reserve density.' };
  }
  globalThis.TokenRadarPlanner = Object.freeze({ plan, scenario });
})();
