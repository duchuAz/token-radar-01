// token-radar-01: the token launch radar's program.
//
// Reads the sealed snapshot (--input <snapshot.json|directory>, default /input/snapshot.json), fits the
// comps model in lib/model.ts on the snapshot's own live protocols, ranks every pre-token protocol the
// full rule admits (the watchlist plus the early rows below the floor), and writes:
//
//   <out>/board.json      the ranked board, {"rows":[...]}, the gate's shape
//   <out>/data.js         window.RADAR = {...}, the dashboard's whole dataset
//   <out>/dashboard/      the page and its source (index.html, app.css, app.js)
//   <out>/screenshots/    three images, the board, a detail view and a filtered view
//   <out>/dossier.json    buildDossier from vendor/makefun-board.ts
//
// Node 22/24, standard library only, erasable TypeScript, no network, no randomness, no Date.now: two
// runs on the same snapshot write byte-identical output.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, modelMarkdown, parseSnapshot, SnapshotError } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the dossier bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> or --name=<value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
} catch (err) {
  const message = err instanceof SnapshotError ? err.message : String(err);
  process.stderr.write(`token radar: ${message}\n`);
  process.exit(2);
}

const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot names, after emptying `to`. */
function copyFiles(from: string, to: string): string[] {
  if (existsSync(to)) rmSync(to, { recursive: true, force: true });
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from).sort()) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
if (!dash.includes('index.html') || !dash.some((n) => n.endsWith('.css')) || !dash.some((n) => n.endsWith('.js'))) {
  process.stderr.write(`token radar: dashboard/ must hold index.html and at least one .css and one .js file\n`);
  process.exit(1);
}
writeFileSync(join(out, 'dashboard', '00-model.md'), modelMarkdown(radar));

const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(
    `token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`,
  );
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const v = radar.validation;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${radar.board_size} rows (${radar.universe.watchlist} watchlist + ${radar.universe.early} early: ${radar.universe.above_floor_extra} above floor, ${radar.universe.below_floor} below), ${radar.live_size} live comps, model ${radar.model_version}\n` +
    `token radar: out-of-fold MAE ${v.mae_log10.toFixed(3)} log10, R2 ${v.r2_log.toFixed(3)}, 80% coverage ${(v.coverage_80 * 100).toFixed(0)}%, rank IC ${v.spearman.toFixed(2)}, slope ${v.calibration_slope.toFixed(2)}, median implied $${Math.round(radar.median_implied_usd).toLocaleString('en-US')}\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dash.length + 1} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);
