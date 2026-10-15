import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { parse, sourceFiles } from '../helpers/source-scan.js';

/**
 * Delays and limits that tests shorten are options no server code sets: only the modules that define and read them
 * name them, so the running Tower always uses their production values (each default has its own test).
 */
const OVERRIDES: Record<string, string[]> = {
  // RunManager option → claude-turn.ts, default CLAUDE_FINISH_RECHECK_MS (runner-background-tasks.test.ts)
  'claudeFinishRecheckMs': ['server/runs/claude-turn.ts', 'server/runs/manager.ts', 'server/runs/turn-host.ts'],
  // TriggerService limits → fire(), default MAX_FIRED_PER_TRIGGER (triggers/limits.test.ts)
  'firedPerTrigger': ['server/triggers/engine.ts', 'server/triggers/polls.ts', 'server/triggers/service.ts', 'server/triggers/store.ts'],
};

function named(path: string, text: string, name: string): boolean {
  let found = false;
  const visit = (node: ts.Node): void => { if (ts.isIdentifier(node) && node.text === name) found = true; else if (!found) ts.forEachChild(node, visit); };
  visit(parse(path, text));
  return found;
}

test('test-only delays and limits are named only where they are defined and read, never set by other server code', async () => {
  const files = await sourceFiles(['server', 'shared', 'client/src', 'scripts']);
  for (const [name, owners] of Object.entries(OVERRIDES)) {
    const naming = [...files].filter(([path, text]) => text.includes(name) && named(path, text, name)).map(([path]) => path).sort();
    assert.deepEqual(naming, [...owners].sort(), name);
  }
});
