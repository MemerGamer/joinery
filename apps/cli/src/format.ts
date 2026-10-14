import type { Thread } from '@joinery/core';

/**
 * Compact human-readable output helpers. No colour codes when stdout is not
 * a TTY. `--json` mode never calls into this module — it prints
 * the parsed API response verbatim.
 */

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Aligned columns, computed from the widest cell per column. */
export function printTable(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): void {
  const widths = headers.map((h, col) => {
    let max = h.length;
    for (const row of rows) {
      const cell = row[col] ?? '';
      if (cell.length > max) max = cell.length;
    }
    return max;
  });

  const bold = process.stdout.isTTY === true;
  const pad = (cell: string, width: number): string => cell + ' '.repeat(width - cell.length);
  const headerLine = headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  ');
  process.stdout.write(`${bold ? `\x1b[1m${headerLine}\x1b[0m` : headerLine}\n`);
  for (const row of rows) {
    process.stdout.write(row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join('  ') + '\n');
  }
}

export function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

/** Threads grouped by file, for pasting into a PR comment or chat. */
export function renderThreadsMarkdown(threads: readonly Thread[]): string {
  if (threads.length === 0) return '_No comments._\n';
  const byPath = new Map<string, Thread[]>();
  for (const t of threads) {
    const list = byPath.get(t.path) ?? [];
    list.push(t);
    byPath.set(t.path, list);
  }

  const lines: string[] = [];
  for (const [path, pathThreads] of [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`## ${path}`, '');
    for (const t of pathThreads) {
      const rangeLabel = t.startLine === t.endLine ? `L${String(t.startLine)}` : `L${String(t.startLine)}-${String(t.endLine)}`;
      const status = t.status === 'resolved' ? ' (resolved)' : '';
      const outdated = t.outdated ? ' _(outdated)_' : '';
      lines.push(`### ${rangeLabel}${status}${outdated}`, '');
      for (const comment of t.comments) {
        lines.push(`**${comment.author}:** ${comment.body}`, '');
      }
    }
  }
  return lines.join('\n');
}
