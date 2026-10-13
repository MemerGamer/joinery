import { describe, expect, test } from 'bun:test';
import { makeAgentCanUseTool } from '../../src/agent/permissions.ts';

describe('makeAgentCanUseTool (no shell, path-fenced reads)', () => {
  const signal = new AbortController().signal;
  const baseOptions = { signal, toolUseID: 'tool_1', requestId: 'req_1' };
  const cwd = process.cwd();
  const agentCanUseTool = makeAgentCanUseTool({ cwd });

  test('auto-approves Read, Grep, Glob for paths under cwd', async () => {
    for (const toolName of ['Read', 'Grep', 'Glob']) {
      const key = toolName === 'Read' ? 'file_path' : 'path';
      const result = await agentCanUseTool(toolName, { [key]: 'foo.ts' }, baseOptions);
      expect(result?.behavior).toBe('allow');
    }
  });

  test('denies Read for a path outside cwd', async () => {
    const result = await agentCanUseTool('Read', { file_path: '/etc/passwd' }, baseOptions);
    expect(result?.behavior).toBe('deny');
  });

  test('allows any mcp__joinery__* tool', async () => {
    const result = await agentCanUseTool('mcp__joinery__reply', { threadId: 't1', bodyMd: 'hi' }, baseOptions);
    expect(result?.behavior).toBe('allow');
  });

  test('denies Bash and every other tool by default, including future/unknown tools', async () => {
    for (const toolName of ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'SomeFutureTool']) {
      const result = await agentCanUseTool(toolName, {}, baseOptions);
      expect(result?.behavior).toBe('deny');
    }
  });
});
