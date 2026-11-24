import { mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildDossier } from './vendor/makefun-board.ts';
import { buildDashboardData, buildRankBoard, parseSnapshot } from './lib/model.ts';

function inputPath(argv: string[]): string {
  const position = argv.indexOf('--input');
  return position >= 0 && argv[position + 1] !== undefined ? argv[position + 1]! : 'input/snapshot.json';
}

const root = resolve('.');
const outputDir = resolve(process.env.MAKEFUN_OUTPUT_DIR ?? 'out');
const snapshot = parseSnapshot(readFileSync(resolve(root, inputPath(process.argv.slice(2))), 'utf8'));
const board = buildRankBoard(snapshot);
const dashboardData = buildDashboardData(snapshot, board);

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(resolve(root, 'dashboard'), join(outputDir, 'dashboard'), { recursive: true });
cpSync(resolve(root, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify(board, null, 2)}\n`, 'utf8');
writeFileSync(join(outputDir, 'data.js'), `globalThis.__TOKEN_RADAR__ = ${JSON.stringify(dashboardData)};\n`, 'utf8');
const dossier = buildDossier(outputDir, {
  text_max_bytes: 65_536,
  screenshots: { max: 8, max_bytes: 512 * 1024 },
  dashboard: { max_files: 8, max_bytes: 64 * 1024 },
});
writeFileSync(join(outputDir, 'dossier.json'), dossier);
