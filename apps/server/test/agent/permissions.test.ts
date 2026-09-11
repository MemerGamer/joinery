import { describe, expect, test } from 'bun:test';
import { agentCanUseTool, isReadOnlyBashCommand } from '../../src/agent/permissions.ts';

describe('isReadOnlyBashCommand (SPEC §9: read-only enforcement)', () => {
  test('allows the documented read-only prefixes', () => {
    expect(isReadOnlyBashCommand('git log --oneline -20')).toBe(true);
    expect(isReadOnlyBashCommand('git show HEAD~1:foo.ts')).toBe(true);
    expect(isReadOnlyBashCommand('git diff main...HEAD')).toBe(true);
    expect(isReadOnlyBashCommand('git blame -L 1,20 foo.ts')).toBe(true);
    expect(isReadOnlyBashCommand('git status')).toBe(true);
    expect(isReadOnlyBashCommand('rg --json TODO src')).toBe(true);
    expect(isReadOnlyBashCommand('ls -la apps/server/src')).toBe(true);
    expect(isReadOnlyBashCommand('cat apps/server/src/index.ts')).toBe(true);
    expect(isReadOnlyBashCommand('head -n 40 SPEC.md')).toBe(true);
    expect(isReadOnlyBashCommand("sed -n '1,40p' SPEC.md")).toBe(true);
    expect(isReadOnlyBashCommand('review show rev_123')).toBe(true);
    expect(isReadOnlyBashCommand('review reading-order get rev_123')).toBe(true);
    expect(isReadOnlyBashCommand('review repos list')).toBe(true);
  });

  test('denies git subcommands that are not read-only', () => {
    expect(isReadOnlyBashCommand('git commit -m x')).toBe(false);
    expect(isReadOnlyBashCommand('git push')).toBe(false);
    expect(isReadOnlyBashCommand('git checkout main')).toBe(false);
    expect(isReadOnlyBashCommand('git reset --hard')).toBe(false);
    expect(isReadOnlyBashCommand('git')).toBe(false);
  });

  test('denies mutating review CLI subcommands', () => {
    expect(isReadOnlyBashCommand('review reading-order set rev_1 --file plan.json')).toBe(false);
    expect(isReadOnlyBashCommand('review reading-order generate rev_1')).toBe(false);
    expect(isReadOnlyBashCommand('review repos add /tmp/x')).toBe(false);
    expect(isReadOnlyBashCommand('review create --branch x')).toBe(false);
    expect(isReadOnlyBashCommand('review reply rev_1 --body-file r.md')).toBe(false);
    expect(isReadOnlyBashCommand('review resolve thread_1')).toBe(false);
    expect(isReadOnlyBashCommand('review revision rev_1 head')).toBe(false);
    expect(isReadOnlyBashCommand('review viewed rev_1 foo.ts')).toBe(false);
  });

  test('denies sed in-place editing', () => {
    expect(isReadOnlyBashCommand("sed -i '' 's/a/b/' foo.ts")).toBe(false);
    expect(isReadOnlyBashCommand("sed -i 's/a/b/' foo.ts")).toBe(false);
    expect(isReadOnlyBashCommand("sed -ni 's/a/b/p' foo.ts")).toBe(false);
    expect(isReadOnlyBashCommand("sed 's/a/b/' foo.ts")).toBe(false); // not "-n"
  });

  test('denies programs entirely outside the allowlist', () => {
    expect(isReadOnlyBashCommand('rm -rf /')).toBe(false);
    expect(isReadOnlyBashCommand('npm install')).toBe(false);
    expect(isReadOnlyBashCommand('curl https://example.com')).toBe(false);
    expect(isReadOnlyBashCommand('python3 -c "print(1)"')).toBe(false);
    expect(isReadOnlyBashCommand('')).toBe(false);
    expect(isReadOnlyBashCommand('   ')).toBe(false);
  });

  test('rejects smuggling a write through a permitted prefix via command chaining', () => {
    expect(isReadOnlyBashCommand('git log; rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('git log && rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('git log || rm -rf x')).toBe(false);
    expect(isReadOnlyBashCommand('git status & rm -rf x')).toBe(false);
  });

  test('rejects smuggling a write through redirection', () => {
    expect(isReadOnlyBashCommand('cat a > b')).toBe(false);
    expect(isReadOnlyBashCommand('cat a >> b')).toBe(false);
    expect(isReadOnlyBashCommand('cat < /etc/passwd > leak.txt')).toBe(false);
  });

  test('rejects smuggling via a pipe to a writing command', () => {
    expect(isReadOnlyBashCommand('git log | xargs rm')).toBe(false);
    expect(isReadOnlyBashCommand('cat foo.ts | tee bar.ts')).toBe(false);
  });

  test('rejects smuggling via backticks and command substitution', () => {
    expect(isReadOnlyBashCommand('cat `touch pwned`')).toBe(false);
    expect(isReadOnlyBashCommand('cat $(touch pwned)')).toBe(false);
    expect(isReadOnlyBashCommand('git log $(rm -rf x)')).toBe(false);
  });

  test('rejects a newline-smuggled second command', () => {
    expect(isReadOnlyBashCommand('git log\nrm -rf x')).toBe(false);
  });

  test('is a pure function: same input always yields the same output, no globals mutated', () => {
    const cmd = 'git log --oneline';
    const results = Array.from({ length: 5 }, () => isReadOnlyBashCommand(cmd));
    expect(new Set(results)).toEqual(new Set([true]));
  });
});

describe('agentCanUseTool (SPEC §9)', () => {
  const signal = new AbortController().signal;
  const baseOptions = { signal, toolUseID: 'tool_1', requestId: 'req_1' };

  test('auto-approves Read, Grep, Glob', async () => {
    for (const toolName of ['Read', 'Grep', 'Glob']) {
      const result = await agentCanUseTool(toolName, { path: 'foo.ts' }, baseOptions);
      expect(result?.behavior).toBe('allow');
    }
  });

  test('gates Bash through the allowlist', async () => {
    const allowed = await agentCanUseTool('Bash', { command: 'git status' }, baseOptions);
    expect(allowed?.behavior).toBe('allow');

    const denied = await agentCanUseTool('Bash', { command: 'git log; rm -rf x' }, baseOptions);
    expect(denied?.behavior).toBe('deny');
  });

  test('denies every other tool by default, including future/unknown tools', async () => {
    for (const toolName of ['Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'SomeFutureTool']) {
      const result = await agentCanUseTool(toolName, {}, baseOptions);
      expect(result?.behavior).toBe('deny');
    }
  });
});

/**
 * `rg` is on the allowlist, but ripgrep can be made to execute an arbitrary
 * command without any shell metacharacter — so the metacharacter guard does
 * not cover these. Found in review of the original allowlist, which accepted
 * `rg` with any arguments at all.
 */
describe('rg command-executing flags', () => {
  test('rejects --pre, which runs a preprocessor binary on every file', () => {
    expect(isReadOnlyBashCommand('rg --pre=/bin/sh pattern .')).toBe(false);
    expect(isReadOnlyBashCommand('rg --pre /bin/sh pattern .')).toBe(false);
  });

  test('rejects --hostname-bin, which runs a binary to resolve the hostname', () => {
    expect(isReadOnlyBashCommand('rg --hostname-bin=/bin/sh pattern')).toBe(false);
  });

  test('rejects --search-zip / -z, which shells out to decompression helpers', () => {
    expect(isReadOnlyBashCommand('rg --search-zip pattern')).toBe(false);
    expect(isReadOnlyBashCommand('rg -z pattern')).toBe(false);
  });

  test('still allows ordinary read-only searches', () => {
    expect(isReadOnlyBashCommand('rg pattern .')).toBe(true);
    expect(isReadOnlyBashCommand('rg -n --glob *.ts pattern src')).toBe(true);
    expect(isReadOnlyBashCommand('rg --pre-glob *.pdf pattern')).toBe(true);
  });
});
