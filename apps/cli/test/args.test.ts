import { describe, expect, test } from 'bun:test';
import { UsageError, parseArgs } from '../src/args.ts';

const FILE_FLAG = { name: 'file', type: 'string' } as const;
const JSON_FLAG = { name: 'json', type: 'boolean' } as const;
const REV_FLAG = { name: 'rev', type: 'string' } as const;

describe('parseArgs', () => {
  test('parses a subcommand path plus positionals and a value flag', () => {
    const parsed = parseArgs(['set', 'rev123', '--file', 'plan.json'], [FILE_FLAG]);
    expect(parsed.positionals).toEqual(['set', 'rev123']);
    expect(parsed.flags['file']).toBe('plan.json');
  });

  test('parses --flag=value form', () => {
    const parsed = parseArgs(['--rev=head'], [REV_FLAG]);
    expect(parsed.flags['rev']).toBe('head');
  });

  test('boolean flags need no value', () => {
    const parsed = parseArgs(['show', 'id1', '--json'], [JSON_FLAG]);
    expect(parsed.flags['json']).toBe(true);
    expect(parsed.positionals).toEqual(['show', 'id1']);
  });

  test('a boolean flag rejects an = value', () => {
    expect(() => parseArgs(['--json=true'], [JSON_FLAG])).toThrow(UsageError);
  });

  test('a string flag without a following value is a usage error', () => {
    expect(() => parseArgs(['--file'], [FILE_FLAG])).toThrow(UsageError);
  });

  test('unknown flags are a hard error, not silently ignored', () => {
    expect(() => parseArgs(['--bogus', 'x'], [FILE_FLAG])).toThrow(UsageError);
  });

  test('-- stops flag parsing; everything after is positional', () => {
    const parsed = parseArgs(['reply', 'id1', '--', '--file', 'plan.json'], [FILE_FLAG]);
    expect(parsed.positionals).toEqual(['reply', 'id1', '--file', 'plan.json']);
    expect(parsed.flags['file']).toBeUndefined();
  });

  test('a single "-" positional (stdin marker) is not treated as a flag', () => {
    const parsed = parseArgs(['reply', 'id1', '--file', '-'], [FILE_FLAG]);
    expect(parsed.flags['file']).toBe('-');
  });

  test('repeated value flags keep the last occurrence', () => {
    const parsed = parseArgs(['--rev', 'working', '--rev', 'head'], [REV_FLAG]);
    expect(parsed.flags['rev']).toBe('head');
  });
});
