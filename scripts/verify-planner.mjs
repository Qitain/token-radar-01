import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

vm.runInThisContext(readFileSync(new URL('../dashboard/planner.js', import.meta.url), 'utf8'));
const planner = globalThis.TokenRadarPlanner;
let checks = 0;
const results = [];
function check(label, callback) { callback(); checks++; results.push({ name: label, pass: true }); console.log(`PASS planner: ${label}`); }
const near = (actual, expected) => assert(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)), `${actual} differs from ${expected}`);
function row(slug, reserve, payout, weekly = 1, low = payout) {
  return { slug, rank: Number(slug.replace(/\D/g, '')) || 1, farm: {
    capital_usd: Math.max(0, reserve - 1), gas_usd: 1, reserve_usd: reserve,
    weekly_hours: weekly, time_hours: weekly * 4, time_cost_usd: 0,
    expected_airdrop_usd: payout, p10_airdrop_usd: low, farmer_share: 0.001,
  } };
}
function exhaustive(rows, options) {
  const scale = options.payoutScale ?? 1, wage = options.timeValue ?? 0;
  const eligible = rows.filter(r => r.farm.p10_airdrop_usd * scale >= r.farm.gas_usd + r.farm.time_hours * wage);
  assert(eligible.length <= 20, 'Exhaustive oracle is only for small independent cases');
  let maximum = 0;
  for (let mask = 0; mask < 2 ** eligible.length; mask++) {
    let cash = 0, hours = 0, payout = 0;
    for (let index = 0; index < eligible.length; index++) if (mask & 2 ** index) {
      const farm = eligible[index].farm;
      cash += farm.reserve_usd; hours += farm.weekly_hours; payout += farm.expected_airdrop_usd * scale;
    }
    if (cash <= options.budget + 1e-9 && hours <= options.weeklyHours + 1e-9) maximum = Math.max(maximum, payout);
  }
  return maximum;
}
function verify(rows, options, oracle = true) {
  const result = planner.plan(rows, options);
  assert.equal(new Set(result.selected.map(item => item.row.slug)).size, result.selected.length, 'Position reused');
  assert(result.selected.every(item => item.scenario.verdict !== 'SKIP'), 'Selected a P10 SKIP');
  assert(result.totals.reserve_usd <= Math.max(0, Number(options.budget) || 0) + 1e-9, 'Cash limit exceeded');
  assert(result.totals.weekly_hours <= Math.max(0, Number(options.weeklyHours) || 0) + 1e-9, 'Time limit exceeded');
  if (oracle) near(result.totals.expected_airdrop_usd, exhaustive(rows, options));
  assert.deepEqual(result, planner.plan(rows, options), 'Planner is nondeterministic');
  for (let index = 1; index < result.selected.length; index++) assert(result.selected[index - 1].scenario.score >= result.selected[index].scenario.score, 'Display order lost density sorting');
  return result;
}

check('a density-greedy trap selects the proven optimum', () => {
  const rows = [row('r1', 6, 12), row('r2', 5, 9), row('r3', 5, 9)];
  const result = verify(rows, { budget: 10, weeklyHours: 2, timeValue: 0 });
  assert.deepEqual(result.selected.map(item => item.row.slug), ['r2', 'r3']);
  assert.equal(result.totals.expected_airdrop_usd, 18);
});
check('time changes the optimum under equal weekly requirements', () => {
  const rows = [row('r1', 6, 12), row('r2', 5, 9), row('r3', 5, 9)];
  const result = verify(rows, { budget: 10, weeklyHours: 1, timeValue: 0 });
  assert.deepEqual(result.selected.map(item => item.row.slug), ['r1']);
});
check('different weekly requirements use exact two-resource selection', () => {
  const rows = [row('r1', 5, 15, 3), row('r2', 4, 11, 1), row('r3', 6, 14, 1), row('r4', 2, 5, 0.5)];
  verify(rows, { budget: 10, weeklyHours: 2, timeValue: 0 });
});
check('fractional cash and time remain undiscretized', () => {
  const rows = [row('r1', 2.35, 7, 0.3), row('r2', 1.25, 5, 0.2), row('r3', 1.1, 4, 0.1)];
  verify(rows, { budget: 2.35, weeklyHours: 0.3, timeValue: 0 });
});
check('zero, invalid inputs, empty data and P10 rejection', () => {
  const rows = [row('r1', 5, 20), row('r2', 5, 20, 1, 0)];
  assert.equal(planner.plan(rows, { budget: 0, weeklyHours: 10 }).selected.length, 0);
  assert.equal(planner.plan(rows, { budget: 100, weeklyHours: 0 }).selected.length, 0);
  assert.equal(planner.plan(rows, { budget: NaN, weeklyHours: Infinity }).selected.length, 0);
  assert.equal(planner.plan([], { budget: 100, weeklyHours: 10 }).selected.length, 0);
  const result = verify(rows, { budget: 100, weeklyHours: 10, timeValue: 0 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.skipped_count, 1);
});
check('zero-resource positions are selected once without a loop', () => {
  const free = row('r1', 0, 10, 0); free.farm.gas_usd = 0;
  const result = verify([free], { budget: 0, weeklyHours: 0, timeValue: 0 });
  assert.equal(result.selected.length, 1);
});

let randomState = 19427;
const random = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return randomState / 2 ** 32; };
check('240 seeded small cases match an independent exhaustive oracle', () => {
  for (let trial = 0; trial < 240; trial++) {
    const uniform = trial % 2 === 0;
    const rows = Array.from({ length: 5 + trial % 7 }, (_, index) => row(`r${index + 1}`, 1 + Math.floor(random() * 20), 2 + Math.floor(random() * 100), uniform ? 0.25 : (1 + Math.floor(random() * 8)) / 4));
    verify(rows, { budget: Math.floor(random() * 75), weeklyHours: Math.floor(random() * 25) / 4, timeValue: trial % 5, payoutScale: 0.5 + trial % 4 });
  }
});

const board = JSON.parse(readFileSync(new URL('../out/board.json', import.meta.url), 'utf8'));
check('the sealed base scenario correctly allocates nothing', () => {
  const result = verify(board, { budget: 10000, weeklyHours: 10, timeValue: 20 }, false);
  assert.equal(result.selected.length, 0);
});
check('all 13 eligible sealed rows at twice allocation match exhaustive portfolios', () => {
  for (const budget of [0, 200, 500, 1000, 2500, 10000]) for (const weeklyHours of [0, 0.4, 1, 2, 10]) {
    verify(board, { budget, weeklyHours, timeValue: 0, payoutScale: 2 });
  }
});
check('full 200-row large scenarios stay exact and responsive', () => {
  const before = performance.now();
  for (const options of [
    { budget: 1000, weeklyHours: 1, timeValue: 0, payoutScale: 100 },
    { budget: 5000, weeklyHours: 5, timeValue: 0, payoutScale: 100 },
    { budget: 10000, weeklyHours: 20, timeValue: 0, payoutScale: 100 },
    { budget: 20000, weeklyHours: 40, timeValue: 0, payoutScale: 100 },
    { budget: 100000, weeklyHours: 100, timeValue: 0, payoutScale: 100 },
  ]) verify(board, options, false);
  const elapsed = performance.now() - before;
  console.log(`INFO planner: five doubled exact 200-row stress cases completed in ${elapsed.toFixed(0)} ms`);
  assert(elapsed < 10000, 'Current sealed-model stress cases unexpectedly slow');
});
console.log(`PASS planner: ${checks}/${checks} checks`);
writeFileSync(new URL('../out/planner-verification.json', import.meta.url), JSON.stringify({ passed: true, checks: results }, null, 2) + '\n');
