/**
 * Builds the release tarball for macOS Apple Silicon:
 * `dist/release/joinery-<version>-darwin-arm64.tar.gz` (+ `.sha256`).
 *
 * The archive root holds `joinery` (compiled CLI + server, ad-hoc signed),
 * `release.json`, `web/` and `migrations/` — the layout `runtime.ts` expects.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const releaseDir = join(root, 'dist', 'release');
const stage = join(releaseDir, 'stage');

async function run(cmd: string[], cwd = root, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(' ')}`);
  return out;
}

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
const archiveName = `joinery-${version}-darwin-arm64.tar.gz`;
const archive = join(releaseDir, archiveName);

await rm(releaseDir, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

console.log('building web app');
await run(['bun', 'run', '--filter', '@joinery/web', 'build']);

console.log('compiling joinery');
await run([
  'bun', 'build', 'apps/cli/src/index.ts', '--compile', '--minify',
  '--target=bun-darwin-arm64', '--outfile', join(stage, 'joinery'),
]);

await writeFile(join(stage, 'release.json'), `${JSON.stringify({ version })}\n`);
await cp(join(root, 'apps', 'web', 'dist'), join(stage, 'web'), { recursive: true });
await cp(join(root, 'apps', 'server', 'migrations'), join(stage, 'migrations'), { recursive: true });

console.log('signing');
await run(['codesign', '--force', '--sign', '-', join(stage, 'joinery')]);
await run(['codesign', '--verify', '--verbose=2', join(stage, 'joinery')]);

await run(['tar', '-czf', archive, '-C', stage, '.'], root, { COPYFILE_DISABLE: '1' });
const sha = (await run(['shasum', '-a', '256', archiveName], releaseDir)).trim();
await writeFile(`${archive}.sha256`, `${sha}\n`);

console.log(`\n${archive}\n${archive}.sha256\n${sha}`);
