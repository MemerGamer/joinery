/**
 * Builds a release tarball per target (macOS Apple Silicon, Linux x64 and
 * arm64): `dist/release/joinery-<version>-<os>-<arch>.tar.gz` (+ `.sha256`).
 *
 * Each archive root holds `joinery` (compiled CLI + server),
 * `release.json`, `web/` and `migrations/` — the layout `runtime.ts` expects.
 * The macOS binary is signed with `JOINERY_SIGN_IDENTITY` when set, ad-hoc otherwise.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const releaseDir = join(root, 'dist', 'release');

async function run(cmd: string[], cwd = root, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'inherit' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) throw new Error(`command failed: ${cmd.join(' ')}`);
  return out;
}

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };

/** One tarball per target. Bun cross-compiles, so all of them build on the macOS runner. */
const TARGETS = ['darwin-arm64', 'linux-x64', 'linux-arm64'] as const;

await rm(releaseDir, { recursive: true, force: true });

console.log('building web app');
await run(['bun', 'run', '--filter', '@joinery/web', 'build']);

// A stable certificate + identifier keeps macOS folder grants (TCC) across
// updates; an ad-hoc signature is tied to the build hash, so every release
// would look like a new app. CI sets these from the signing secrets.
const identity = process.env['JOINERY_SIGN_IDENTITY']?.trim();
const keychain = process.env['JOINERY_SIGN_KEYCHAIN']?.trim();

for (const target of TARGETS) {
  const stage = join(releaseDir, `stage-${target}`);
  const archiveName = `joinery-${version}-${target}.tar.gz`;
  const archive = join(releaseDir, archiveName);
  await mkdir(stage, { recursive: true });

  console.log(`compiling joinery for ${target}`);
  await run([
    'bun', 'build', 'apps/cli/src/index.ts', '--compile', '--minify',
    `--target=bun-${target}`, '--outfile', join(stage, 'joinery'),
  ]);

  await writeFile(join(stage, 'release.json'), `${JSON.stringify({ version })}\n`);
  await cp(join(root, 'apps', 'web', 'dist'), join(stage, 'web'), { recursive: true });
  await cp(join(root, 'apps', 'server', 'migrations'), join(stage, 'migrations'), { recursive: true });

  if (target.startsWith('darwin-')) {
    if (identity) console.log('signing with the Joinery certificate');
    else console.warn('signing ad-hoc (JOINERY_SIGN_IDENTITY unset): folder permissions will not survive updates');
    await run([
      'codesign', '--force', '--sign', identity || '-', '--identifier', 'dev.joinery.server',
      ...(keychain ? ['--keychain', keychain] : []), join(stage, 'joinery'),
    ]);
    await run(['codesign', '--verify', '--verbose=2', join(stage, 'joinery')]);
  }

  await run(['tar', '-czf', archive, '-C', stage, '.'], root, { COPYFILE_DISABLE: '1' });
  await rm(stage, { recursive: true, force: true });
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(await Bun.file(archive).arrayBuffer());
  const sha = `${hasher.digest('hex')}  ${archiveName}`;
  await writeFile(`${archive}.sha256`, `${sha}\n`);

  console.log(`\n${archive}\n${archive}.sha256\n${sha}\n`);
}
