import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { parse, root } from '../../helpers/source-scan.js';

/**
 * The run manager keeps the run lifecycle only. Provider protocol, state file formats, credential plumbing and
 * permission logic each have their own module (see server/runs/*-turn.ts, run-history.ts, turn-env.ts,
 * permission-continuation.ts); this keeps them from drifting back.
 */
const FORBIDDEN_CALLS = ['spawn', 'mkdtemp', 'writePrivateJson', 'readPrivateJson', 'towerInstructionsBlock', 'privateMcpConfig', 'turnEnv', 'JSON.parse'];
const FORBIDDEN_CONSTRUCTIONS = ['ClaudeControl', 'ReplyLog', 'BackgroundTaskTracker', 'WakeupTracker'];
const FORBIDDEN_NAMES = ['CALLER_CAPABILITY_ENV'];

/** What the manager calls, constructs and names that belongs elsewhere, as `kind name` lines. */
export function misplaced(path: string, text: string): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && FORBIDDEN_CALLS.includes(node.expression.getText())) found.push(`call ${node.expression.getText()}`);
    if (ts.isNewExpression(node) && FORBIDDEN_CONSTRUCTIONS.includes(node.expression.getText())) found.push(`new ${node.expression.getText()}`);
    if (ts.isIdentifier(node) && FORBIDDEN_NAMES.includes(node.text)) found.push(`name ${node.text}`);
    ts.forEachChild(node, visit);
  };
  visit(parse(path, text));
  return found;
}

test('the run manager keeps the run lifecycle only', async () => {
  assert.deepEqual(misplaced('server/runs/manager.ts', await readFile(join(root, 'server', 'runs', 'manager.ts'), 'utf8')), []);
});

test('the shape check finds calls, constructions and names, never text in strings or comments', () => {
  const text = `
spawn(file); JSON.parse(line); new ClaudeControl({}); env[CALLER_CAPABILITY_ENV] = '';
// spawn(file) new ReplyLog(run)
const note = 'writePrivateJson(path)';
other.spawn(file); new Map();
`;
  assert.deepEqual(misplaced('fixture.ts', text), ['call spawn', 'call JSON.parse', 'new ClaudeControl', 'name CALLER_CAPABILITY_ENV']);
});
