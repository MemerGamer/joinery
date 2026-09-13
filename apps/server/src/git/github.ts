/**
 * PR discovery via the `gh` CLI (SPEC §5, remote poll). Looked up at most
 * once per review — once a number is found and persisted, the engine never
 * calls this again for that review.
 */

export type FindOpenPrOptions = { cwd: string };

/**
 * Resolve the open PR number for `branch`, or `null` if there isn't one (or
 * `gh` isn't installed/authenticated). Never throws: a missing/unauthed
 * `gh` is equivalent to "no PR known yet", not an engine error.
 */
export async function findOpenPrNumberForBranch(
  branch: string,
  options: FindOpenPrOptions,
): Promise<number | null> {
  let proc;
  try {
    proc = Bun.spawn(['gh', 'pr', 'view', branch, '--json', 'number', '--jq', '.number'], {
      cwd: options.cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
  } catch {
    return null;
  }
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) return null;
  const n = Number(stdout.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
}
