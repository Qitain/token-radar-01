import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildDashboardData, buildRankBoard, parseSnapshot, SEALED_SHA256 } from './lib/model.ts';

function inputPath(argv: string[]): string {
  const position = argv.indexOf('--input');
  return position >= 0 && argv[position + 1] !== undefined ? argv[position + 1]! : 'input/snapshot.json';
}

const root = resolve('.');
const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? 'out');
const inputBytes = readFileSync(resolve(root, inputPath(process.argv.slice(2))));
const digest = createHash('sha256').update(inputBytes).digest('hex');
if (digest !== SEALED_SHA256) throw new Error('The input does not match the sealed snapshot; refusing to rebuild');
if (outputDir === root || !outputDir.startsWith(root + '/') || ['input', 'lib', 'dashboard', 'scripts', 'vendor', 'screenshots', '.git'].some(name => outputDir === resolve(root, name) || outputDir.startsWith(resolve(root, name) + '/'))) throw new Error('Output must be a disposable directory inside the project');
const snapshot = parseSnapshot(inputBytes.toString('utf8'));
const board = buildRankBoard(snapshot);
const dashboardData = buildDashboardData(snapshot, board, digest);
for (const check of dashboardData.integrity.checks) console.log(`${check.pass ? 'PASS' : 'FAIL'} ${check.id}: ${String(check.actual)}`);
if (!dashboardData.integrity.pass) throw new Error('Integrity checks failed; output was not replaced');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(resolve(root, 'dashboard'), join(outputDir, 'dashboard'), { recursive: true });
cpSync(resolve(root, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
writeFileSync(join(outputDir, 'data.js'), `globalThis.__TOKEN_RADAR__ = ${JSON.stringify(dashboardData)};\n`, 'utf8');
writeFileSync(join(outputDir, 'model-report.json'), `${JSON.stringify({ schema: dashboardData.schema, snapshot: dashboardData.snapshot, model: dashboardData.model, integrity: dashboardData.integrity }, null, 2)}\n`, 'utf8');
writeFileSync(join(outputDir, 'audit.json'), `${JSON.stringify({ issued: dashboardData.issued, excluded: dashboardData.audit }, null, 2)}\n`, 'utf8');
// Put computed research evidence inside the dossier's dashboard text as well as data.js.
const v = dashboardData.model.valuation, o = dashboardData.model.odds, a = dashboardData.model.farm_assumptions;
const evidence = [
  '# Token Radar v2 — computed evidence',
  `Sealed ${snapshot.as_of}; SHA-256 ${digest}. ${board.length} ranked + ${dashboardData.issued.length} issued + ${dashboardData.audit.length} excluded = ${snapshot.protocols.length}.`,
  v.selected.equation,
  v.validation.metric,
  ...v.curves.map((r: any) => `${r.form}: LOO ${r.loo.median_error_factor}x, walk-forward ${r.walk_forward.median_error_factor}x, within2x ${r.loo.within_2x}/${r.walk_forward.within_2x}.`),
  ...v.ablation.terms.map((r: any) => `${r.term}: ${r.retained ? 'KEEP' : 'CUT'}. With term LOO/WF ${r.with_term.loo.median_error_factor}x/${r.with_term.walk_forward.median_error_factor}x; without ${r.without_term.loo.median_error_factor}x/${r.without_term.walk_forward.median_error_factor}x. ${r.reason}`),
  `Untouched outer selection audit: ${JSON.stringify(v.validation.nested_audit.metrics)}; train ${v.validation.nested_audit.train_n}, test ${v.validation.nested_audit.test_n}. ${v.validation.nested_audit.limitation}`,
  `Intervals: ${v.intervals.method} Calibration coverage ${v.intervals.calibration_coverage}; older-only residual calibration on later cohort ${v.intervals.walk_forward_coverage}; untouched outer coverage ${v.validation.nested_audit.interval.coverage}.`,
  `Bootstrap: ${v.bootstrap.refits} refits, seed ${v.bootstrap.seed}. ${v.bootstrap.interpretation}`,
  `Odds: ${o.method} LOO ${JSON.stringify(o.validation.loo)}; chronological ${JSON.stringify(o.validation.walk_forward)}. ${o.caveat}`,
  `Farm assumptions: ${JSON.stringify(a)}`,
  `Farm verdict counts: ${JSON.stringify(board.reduce((counts: any, r: any) => { counts[r.farm.verdict] = (counts[r.farm.verdict] ?? 0) + 1; return counts; }, {}))}.`,
  ...[board[0], board[Math.floor(board.length / 2)], board.at(-1)].map((r: any) => `${r.name}: TVL ${r.tvl_usd}; implied ${r.implied_value_usd}; predictive P10/P90 ${r.implied_p10_usd}/${r.implied_p90_usd}; p=${r.token_probability}; farmer share ${r.farm.farmer_share}; gas ${r.farm.gas_usd}; hours ${r.farm.time_hours}; time cost ${r.farm.time_cost_usd}; expected payout ${r.farm.expected_airdrop_usd}; net/h ${r.farm.net_per_hour}; P10 net ${r.farm.p10_net_usd}; ${r.farm.verdict}.`),
  ...v.limitations,
].join('\n\n');
writeFileSync(join(outputDir, 'dashboard', '00-evidence.md'), evidence + '\n', 'utf8');
const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 8, max_bytes: 512 * 1024 },
  dashboard: { max_files: 8, max_bytes: 128 * 1024 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);
