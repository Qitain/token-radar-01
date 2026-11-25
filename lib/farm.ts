// Scenario inputs are declared assumptions, never observations or fitted gas prices.
export const FARM_ASSUMPTIONS = {
  pool_fraction: 0.10,
  qualifying_wallets: 10_000,
  farmer_share: 0.10 / 10_000,
  time_value_usd_per_hour: 20,
  gas_per_transaction_usd: 2,
  hold_weeks: 4,
  label: 'Editable equal-wallet allocation scenario. Allocation, fees, time and eligibility are assumptions; the snapshot observes none of them.',
  payout_formula: 'implied value × empirical token prevalence × (assumed farmer pool / hypothetical qualifying wallets)',
  cost_formula: 'sum(step transactions) × assumed fee + sum(step minutes) / 60 × hourly time value',
  capital_formula: 'max(80, min(1500, round(sqrt(snapshot TVL) / 120))) USD; a sizing convention, not an observed eligibility minimum',
  verdict_rule: 'SKIP if P10 valuation-scenario net < 0; THIN if net is nonnegative but below total cost; FARM if net is at least total cost',
  caveat: 'P10 describes valuation uncertainty, not the unconditional payout percentile. No launch horizon, eligibility, allocation or reward yield is observed. Principal is assumed fully recoverable; losses, slippage, tax, opportunity cost and yield are outside this scenario.',
};

const dollars = (n: number) => '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function actionFor(protocol: any, capital: number, chain: string): string {
  const kind = (protocol.category ?? '').toLowerCase();
  if (/curator|allocator|vault|yield|rwa/.test(kind)) return `Inspect a ${protocol.name} vault on ${chain}; if public deposits are available, test ${dollars(capital)} and retain the receipt`;
  if (/lend|borrow|cdp/.test(kind)) return `Inspect ${protocol.name} on ${chain}; if permissionless supply is available, supply ${dollars(capital)} without borrowing`;
  if (/dex|amm|liquidity/.test(kind)) return `Inspect ${protocol.name} on ${chain}; test a ${dollars(capital)} liquidity position only after checking inventory and price-range risk`;
  if (/bridge/.test(kind)) return `Inspect ${protocol.name}'s supported route on ${chain}; test a ${dollars(capital)} transfer only after confirming both endpoints and return liquidity`;
  if (/stak/.test(kind)) return `Inspect ${protocol.name} on ${chain}; test ${dollars(capital)} only after confirming redemption delays and asset exposure`;
  return `Inspect ${protocol.name} on ${chain}; test a ${dollars(capital)} position only if there is a public action and a documented exit`;
}

export function farmFor(protocol: any, value: any, probability: number) {
  const a = FARM_ASSUMPTIONS;
  const capital = Math.max(80, Math.min(1500, Math.round(Math.sqrt(protocol.tvl_usd) / 120)));
  const chain = protocol.chains[0] ?? 'the recorded network';
  const descriptors = [
    { minutes: 5, transactions: 0, text: `Check ${protocol.name}'s official interface, contracts, asset risks and public access on ${chain}. Stop if access is restricted; no eligibility is established by this snapshot.` },
    { minutes: 10, transactions: 1, text: `Prepare ${dollars(capital)} of recoverable principal on ${chain} and make one limited approval. Funding and bridge fees beyond this one-transaction allowance require a new budget.` },
    { minutes: 15, transactions: 1, text: actionFor(protocol, capital, chain) + '. This is a proposed research workflow, not evidence of points or an airdrop.' },
    { minutes: 5, transactions: 0, text: 'Set position and loss limits; record receipt balances, withdrawal conditions and transaction hashes. Do not assume a reward page or a token announcement exists.' },
    { minutes: a.hold_weeks * 10, transactions: a.hold_weeks, text: `For ${a.hold_weeks} assumed weeks, inspect balances and make at most one necessary action per week. This budget assumes 10 active minutes and one transaction per weekly check; passive holding time is not work.` },
    { minutes: 20, transactions: 1, text: 'Test a complete withdrawal, reconcile returned principal and actual fees, and close the log. One exit transaction is budgeted; any separate claim, approval revocation or extra leg needs additional fees.' },
  ];
  const steps = descriptors.map(step => ({ ...step, gas_usd: step.transactions * a.gas_per_transaction_usd }));
  const gas = steps.reduce((sum, step) => sum + step.gas_usd, 0);
  const hours = steps.reduce((sum, step) => sum + step.minutes, 0) / 60;
  const timeCost = hours * a.time_value_usd_per_hour;
  const cost = gas + timeCost;
  const expected = value.implied_value_usd * probability * a.farmer_share;
  // Take the more conservative of predictive residual and bootstrap lower bounds.
  const conservativeValue = Math.min(value.implied_p10_usd, value.bootstrap_p10_usd);
  const low = conservativeValue * probability * a.farmer_share;
  const net = expected - cost;
  const lowNet = low - cost;
  const verdict = lowNet < 0 ? 'SKIP' : lowNet < cost ? 'THIN' : 'FARM';
  const breakEven = cost / (value.implied_value_usd * probability);
  return {
    verdict, capital_usd: capital, gas_usd: gas,
    transactions: steps.reduce((sum, step) => sum + step.transactions, 0),
    hold_weeks: a.hold_weeks, time_hours: hours, weekly_hours: hours / a.hold_weeks,
    time_cost_usd: timeCost, total_cost_usd: cost, reserve_usd: capital + gas,
    expected_airdrop_usd: expected, p10_airdrop_usd: low,
    net_usd: net, p10_net_usd: lowNet, net_per_hour: net / hours,
    p10_net_per_hour: lowNet / hours, break_even_share: breakEven,
    p10_break_even_share: cost / (conservativeValue * probability),
    break_even_wallets: a.pool_fraction / breakEven,
    min_pool_fraction: breakEven * a.qualifying_wallets,
    farmer_share: a.farmer_share, conservative_value_usd: conservativeValue,
    eligibility: 'Unverified; inspect public access before allocating funds', steps,
    assumptions: 'Equal allocation across hypothetical eligible wallets; no capital weighting or observed reward rate. P10 net is a low-valuation scenario, not a guaranteed payoff.',
  };
}

export function farmStepStrings(farm: ReturnType<typeof farmFor>): string[] {
  return farm.steps.map(step => `${step.text} Assumed cost: ${dollars(step.gas_usd)} gas; active time: ${step.minutes} minutes (${step.transactions} transactions).`);
}
