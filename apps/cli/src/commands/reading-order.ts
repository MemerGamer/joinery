import { readFileSync } from 'node:fs';
import * as client from '../client.ts';
import { UsageError } from '../args.ts';
import { printLine, printTable } from '../format.ts';
import { PlanValidationError, parsePlan } from '../plan.ts';
import type { Command } from './types.ts';
import { maybePrintJson, parseCommand, requireFlag, requirePositional, wantsHelp } from './shared.ts';

export const get: Command = {
  path: 'reading-order get',
  summary: 'Show the reading order',
  usage: 'review reading-order get <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(get.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.getReadingOrder(id);
    if (maybePrintJson(parsed, result)) return;
    if (result.readingOrder === null) {
      printLine('no reading order yet — run `joinery reading-order generate <id>`');
      return;
    }
    printTable(
      ['#', 'TITLE', 'FILES'],
      result.readingOrder.steps.map((s) => [String(s.idx), s.title, String(s.files.length)]),
    );
    if (result.readingOrder.unassignedPaths.length > 0) {
      printLine(`unassigned: ${result.readingOrder.unassignedPaths.join(', ')}`);
    }
  },
};

export const set: Command = {
  path: 'reading-order set',
  summary: 'Set the reading order from a plan file',
  usage: 'review reading-order set <id> --file plan.json [--json]',
  async run(argv) {
    const parsed = parseCommand(argv, [{ name: 'file', type: 'string' }]);
    if (wantsHelp(parsed)) return printLine(set.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const filePath = requireFlag(parsed, 'file');

    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`could not read ${filePath}: ${reason}`);
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new UsageError(`${filePath} is not valid JSON: ${reason}`);
    }

    let plan;
    try {
      plan = parsePlan(json);
    } catch (err) {
      if (err instanceof PlanValidationError) {
        throw new UsageError(`${filePath} does not match the reading-order plan shape:\n${err.message}`);
      }
      throw err;
    }

    const result = await client.setReadingOrder(id, plan);
    if (maybePrintJson(parsed, result)) return;
    printLine(`reading order set: ${result.readingOrder.steps.length} steps (v${result.readingOrder.version})`);
  },
};

export const generate: Command = {
  path: 'reading-order generate',
  summary: 'Ask an agent to generate the reading order',
  usage: 'review reading-order generate <id> [--json]',
  async run(argv) {
    const parsed = parseCommand(argv);
    if (wantsHelp(parsed)) return printLine(generate.usage);
    const id = requirePositional(parsed.positionals, 0, 'id');
    const result = await client.generateReadingOrder(id);
    if (maybePrintJson(parsed, result)) return;
    printLine(`started run ${result.run.id} (${result.run.status})`);
  },
};
