export interface Protocol {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface ModelMetrics {
  age_days: number | null;
  category_multiplier: number;
  growth_momentum: number;
  maturity_factor: number;
  multi_chain_factor: number;
  data_completeness: number;
  implied_value_usd: number;
}

export interface BoardRow extends Protocol, ModelMetrics {
  rank: number;
  has_token: false;
  watchlist: boolean;
  selection_reason: string;
  farm_steps: string[];
}

export interface IssuedRow extends Protocol {
  has_token: true;
  age_days: number | null;
}

interface CategoryCalibration {
  sample_count: number;
  category_median_multiplier: number | null;
  clipped_median_multiplier: number | null;
  multiplier: number;
}

export interface Calibration {
  sample_count: number;
  global_multiplier: number;
  clip_p10_multiplier: number;
  clip_p90_multiplier: number;
  categories: Record<string, CategoryCalibration>;
}

export interface DashboardData {
  schema: string;
  snapshot: {
    as_of: string;
    source: string;
    floor_usd: number;
    protocol_count: number;
    watchlist_count: number;
  };
  model: {
    formula: string;
    parameters: Record<string, unknown>;
    calibration: Calibration;
  };
  board: BoardRow[];
  issued: IssuedRow[];
  categories: string[];
  chains: string[];
}

export function isPreToken(protocol: Protocol): boolean {
  return protocol.mcap_usd === null
    && protocol.gecko_id === null
    && protocol.symbol === null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value);
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined || value === '' ? null : String(value);
}

function text(value: unknown, fallback: string): string {
  const result = String(value ?? '').trim();
  return result === '' ? fallback : result;
}

function uniqueTexts(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const item = String(value ?? '').trim();
    if (item !== '' && !seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

export function parseSnapshot(input: unknown): Snapshot {
  const value = typeof input === 'string' ? JSON.parse(input) : input;
  if (!record(value)) throw new TypeError('Snapshot must be an object');
  if (!Array.isArray(value.protocols)) throw new TypeError('Snapshot is missing the protocols array');
  const protocols = value.protocols.map((item, index) => {
    if (!record(item)) throw new TypeError(`protocols[${index}] must be an object`);
    return {
      slug: text(item.slug, `protocol-${index + 1}`),
      name: text(item.name, text(item.slug, `Protocol ${index + 1}`)),
      category: nullableText(item.category),
      chains: uniqueTexts(item.chains),
      tvl_usd: Math.max(0, finiteNumber(item.tvl_usd, 0)),
      change_7d: nullableNumber(item.change_7d),
      mcap_usd: nullableNumber(item.mcap_usd),
      listed_at: nullableText(item.listed_at),
      gecko_id: nullableText(item.gecko_id),
      symbol: nullableText(item.symbol),
    } satisfies Protocol;
  });
  const watchlist = uniqueTexts(value.watchlist);
  return {
    as_of: text(value.as_of, '1970-01-01'),
    source: text(value.source, 'unknown'),
    floor_usd: Math.max(0, finiteNumber(value.floor_usd, 50_000_000)),
    protocols,
    watchlist,
  };
}

function quantile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * percentile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
}

function dateMillis(value: string): number | null {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const snapshotMillis = dateMillis(asOf);
  const listedMillis = dateMillis(listedAt);
  if (snapshotMillis === null || listedMillis === null) return null;
  return Math.round((snapshotMillis - listedMillis) / 86_400_000);
}

export function calibrateModel(snapshot: Snapshot): Calibration {
  const issued = snapshot.protocols.filter((protocol) => (
    !isPreToken(protocol)
    && protocol.mcap_usd !== null
    && protocol.mcap_usd > 0
    && protocol.tvl_usd > 0
    && protocol.category !== null
  ));
  const allLogs = issued
    .map((protocol) => Math.log(protocol.mcap_usd! / protocol.tvl_usd))
    .sort((a, b) => a - b);
  const globalMedianLog = quantile(allLogs, 0.5);
  const p10Log = quantile(allLogs, 0.1);
  const p90Log = quantile(allLogs, 0.9);
  const grouped = new Map<string, number[]>();
  for (const protocol of issued) {
    const category = protocol.category!;
    const values = grouped.get(category) ?? [];
    values.push(Math.log(protocol.mcap_usd! / protocol.tvl_usd));
    grouped.set(category, values);
  }
  const categories: Record<string, CategoryCalibration> = {};
  for (const [category, values] of grouped) {
    values.sort((a, b) => a - b);
    const categoryMedianLog = quantile(values, 0.5);
    const clippedLog = Math.max(p10Log, Math.min(p90Log, categoryMedianLog));
    const weight = values.length / (values.length + 8);
    categories[category] = {
      sample_count: values.length,
      category_median_multiplier: Math.exp(categoryMedianLog),
      clipped_median_multiplier: Math.exp(clippedLog),
      multiplier: Math.exp(clippedLog) * weight + Math.exp(globalMedianLog) * (1 - weight),
    };
  }
  return {
    sample_count: issued.length,
    global_multiplier: Math.exp(globalMedianLog),
    clip_p10_multiplier: Math.exp(p10Log),
    clip_p90_multiplier: Math.exp(p90Log),
    categories,
  };
}

function categoryMultiplier(category: string | null, calibration: Calibration): number {
  return category === null || calibration.categories[category] === undefined
    ? calibration.global_multiplier
    : calibration.categories[category]!.multiplier;
}

export function metricsFor(protocol: Protocol, snapshot: Snapshot, calibration: Calibration): ModelMetrics {
  const ageDays = ageInDays(snapshot.as_of, protocol.listed_at);
  const growth = protocol.change_7d === null
    ? 1
    : Math.exp(0.22 * Math.tanh(protocol.change_7d / 25));
  const maturity = ageDays === null
    ? 1
    : 0.75
      + 0.45 * (1 - Math.exp(-ageDays / 180))
      * Math.exp(-Math.max(0, ageDays - 1095) / 1460);
  const chainCount = Math.max(1, new Set(protocol.chains).size);
  const multiChain = 1 + 0.07 * Math.log2(Math.min(8, chainCount));
  const completeness = (protocol.change_7d === null ? 0.92 : 1)
    * (ageDays === null ? 0.88 : 1)
    * (protocol.category === null ? 0.92 : 1);
  const implied = protocol.tvl_usd
    * categoryMultiplier(protocol.category, calibration)
    * growth
    * maturity
    * multiChain
    * completeness;
  return {
    age_days: ageDays,
    category_multiplier: categoryMultiplier(protocol.category, calibration),
    growth_momentum: growth,
    maturity_factor: maturity,
    multi_chain_factor: multiChain,
    data_completeness: completeness,
    implied_value_usd: implied,
  };
}

function usd(value: number): string {
  return `$${Math.max(0, Math.round(value)).toLocaleString('en-US')}`;
}

function protocolKind(category: string | null): string {
  const value = (category ?? '').toLowerCase();
  if (value.includes('lending') || value.includes('money market') || value.includes('borrow')) return 'Lending';
  if (value.includes('dex') || value.includes('amm') || value.includes('exchange')) return 'DEX';
  if (value.includes('bridge') || value.includes('cross chain')) return 'Bridge';
  if (value.includes('stake') || value.includes('restaking')) return 'Staking';
  if (value.includes('cdp') || value.includes('stablecoin')) return 'Stablecoin';
  if (value.includes('yield') || value.includes('farm') || value.includes('vault') || value.includes('allocator') || value.includes('curator') || value.includes('rwa')) return 'Yield Strategy';
  return 'Strategy';
}

export function makeFarmSteps(protocol: Protocol, snapshot: Snapshot): string[] {
  const kind = protocolKind(protocol.category);
  const primaryChain = protocol.chains[0] ?? 'Mainnet';
  const secondaryChain = protocol.chains[1] ?? primaryChain;
  const chainCount = Math.max(1, new Set(protocol.chains).size);
  const age = ageInDays(snapshot.as_of, protocol.listed_at);
  const ageNote = age === null
    ? 'Age data is missing; treat this as a new strategy'
    : age < 90
      ? `The protocol record is about ${Math.max(0, age)} days old; start with a small test`
      : `The protocol record is ${age} days old; use a staged position`;
  const testAmount = Math.max(20, Math.min(150, Math.round(Math.log10(protocol.tvl_usd + 10) * 18)));
  const mainAmount = Math.max(80, Math.min(1500, Math.round(Math.sqrt(protocol.tvl_usd) / 120)));
  const gas = Math.max(2, Math.round(2 + chainCount * 1.5));
  const bridgeFee = Math.max(5, Math.round(8 + chainCount * 2));
  const action = {
    Lending: `On ${primaryChain}, supply about ${usd(mainAmount)} in USDC and confirm the rate and liquidation settings`,
    DEX: `On ${primaryChain}, pair about ${usd(mainAmount)} in two assets, provide liquidity, and confirm the price range`,
    Bridge: `Send a small cross-chain transfer of about ${usd(testAmount)} from ${primaryChain} to ${secondaryChain}, then verify delivery`,
    Staking: `On ${primaryChain}, stake about ${usd(mainAmount)} of the native asset and confirm the delegate, unlock period, and reward rules`,
    Stablecoin: `On ${primaryChain}, use about ${usd(testAmount)} in collateral to mint a small amount of stablecoins while keeping a safety margin`,
    'Yield Strategy': `On ${primaryChain}, choose a vault or strategy matching ${protocol.category ?? 'the current category'} and deposit about ${usd(mainAmount)}`,
    Strategy: `On ${primaryChain}, run a small strategy action with about ${usd(testAmount)} and confirm the asset flow and exit route`,
  }[kind];
  return [
    `Verify ${protocol.name} on ${primaryChain}, including the contract entry point and risk notes. ${ageNote}. Cost: about $0; Time: 5 minutes.`,
    `Prepare test funds and confirm wallet balance, approvals, and network fees. If ${chainCount} chains are involved, start with one chain only. Cost: about ${usd(gas)} in gas; Time: 10 minutes.`,
    `${action}. Cost: about ${usd(gas)} in network fees, plus the capital deployed; Time: 10 to 20 minutes.`,
    `Set slippage, limits, position caps, and the minimum acceptable outcome; ${kind === 'Bridge' ? 'also verify the destination address' : 'review the transaction before signing'}. Cost: about $0; Time: 5 minutes.`,
    `Save the transaction hash and monitor ${protocol.name} for balance, yield, or delivery changes. If anything looks wrong, stop adding funds and ${kind === 'Bridge' ? `reserve about ${usd(bridgeFee)} for a follow-up bridge fee` : 'keep enough gas to exit'}. Cost: about ${usd(gas)} for monitoring and actions; Time: 30 minutes.`,
    `After one small validation cycle, decide whether to scale the position. Test withdrawal, liquidity removal, unstaking, or a bridge return first; record actual costs and settlement time. Cost: about ${usd(gas)} to exit; Time: 15 to 30 minutes.`,
  ];
}

export function buildRankBoard(snapshot: Snapshot): BoardRow[] {
  const calibration = calibrateModel(snapshot);
  const bySlug = new Map(snapshot.protocols.map((protocol) => [protocol.slug, protocol]));
  const watchlist = new Set(snapshot.watchlist);
  const watchProtocols: Protocol[] = [];
  for (const slug of snapshot.watchlist) {
    const protocol = bySlug.get(slug);
    if (protocol === undefined) throw new Error(`Watchlist protocol not found: ${slug}`);
    if (!isPreToken(protocol)) throw new Error(`Watchlist protocol already has a token: ${slug}`);
    watchProtocols.push(protocol);
  }
  const thresholdProtocols = snapshot.protocols
    .filter((protocol) => isPreToken(protocol) && !watchlist.has(protocol.slug) && protocol.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, 160);
  if (thresholdProtocols.length < 160) throw new Error('Fewer than 160 pre-token protocols are below the TVL floor');
  const selected = [...watchProtocols, ...thresholdProtocols];
  const rows = selected.map((protocol) => ({
    ...protocol,
    ...metricsFor(protocol, snapshot, calibration),
    rank: 0,
    has_token: false as const,
    watchlist: watchlist.has(protocol.slug),
    selection_reason: watchlist.has(protocol.slug) ? 'Watchlist' : 'Below TVL floor',
    farm_steps: makeFarmSteps(protocol, snapshot),
  }));
  rows.sort((a, b) => (
    b.implied_value_usd - a.implied_value_usd
    || b.tvl_usd - a.tvl_usd
    || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
  ));
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function buildIssuedRows(snapshot: Snapshot): IssuedRow[] {
  return snapshot.protocols
    .filter((protocol) => !isPreToken(protocol))
    .sort((a, b) => (
      (b.mcap_usd ?? -Infinity) - (a.mcap_usd ?? -Infinity)
      || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
    ))
    .map((protocol) => ({ ...protocol, has_token: true as const, age_days: ageInDays(snapshot.as_of, protocol.listed_at) }));
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function buildDashboardData(snapshot: Snapshot, board: BoardRow[]): DashboardData {
  const calibration = calibrateModel(snapshot);
  const categories = sortedStrings(snapshot.protocols.map((protocol) => protocol.category).filter((value): value is string => value !== null));
  const chains = sortedStrings(snapshot.protocols.flatMap((protocol) => protocol.chains));
  return {
    schema: 'token-radar/v1',
    snapshot: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      protocol_count: snapshot.protocols.length,
      watchlist_count: snapshot.watchlist.length,
    },
    model: {
      formula: 'Implied value = TVL × Category multiplier × Growth momentum × Maturity × Multi-chain factor × Data completeness',
      parameters: {
        growth: '1 when change_7d is missing; otherwise exp(0.22 × tanh(change_7d / 25))',
        maturity: '1 when age is missing; otherwise 0.75 + 0.45 × (1 - exp(-days / 180)) × exp(-max(0, days - 1095) / 1460)',
        multi_chain: '1 + 0.07 × log2(min(8, max(1, deduplicated chain count)))',
        completeness: 'change_7d missing ×0.92; age missing ×0.88; category missing ×0.92',
        calibration: '128 valid issued-token samples; category medians clipped to the global 10th to 90th percentile range, then shrunk toward the global median by n/(n+8)',
      },
      calibration,
    },
    board,
    issued: buildIssuedRows(snapshot),
    categories,
    chains,
  };
}
