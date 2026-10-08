import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * Every Claude/Codex call Tower starts by itself takes its model from the model roles (server/models/settings.ts), so
 * Settings › Models is the whole list. These checks fail when a launch or a model name appears outside it.
 */
const root = join(import.meta.dirname, '..', '..', '..');
async function sources(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.tsx?$/.test(entry.name)) files.set(path.split('\\').join('/'), await readFile(join(root, path), 'utf8'));
    }
  };
  for (const dir of ['server', 'shared', join('client', 'src')]) await walk(dir);
  return files;
}

test('model names are written only where the roles and the catalog are defined', async () => {
  const allowed = new Set(['shared/models.ts', 'server/providers/capabilities.ts', 'server/models/settings.ts']);
  const found = [...(await sources())].filter(([path, text]) => !allowed.has(path) && /['"`](opus|sonnet|haiku|fable|gpt-\d[\w.-]*)['"`]/.test(text)).map(([path]) => path);
  assert.deepEqual(found, [], 'take the model from resolveModel(role) (server/models/settings.ts) and add the role to shared/models.ts');
});

test('only the known launchers pass a model to Claude or Codex, and they start provider CLIs', async () => {
  const files = await sources();
  const model = [...files].filter(([, text]) => /['"`]--model['"`]/.test(text)).map(([path]) => path).sort();
  // The one-shot runner, the voice first reply, session turns, the role flags, and the parser of agents' own exec lines.
  assert.deepEqual(model, ['server/auto-prompt/native.ts', 'server/master/first-reply.ts', 'server/runs/claude-args.ts', 'server/sessions/exec-lineage.ts', 'shared/models.ts']);
  const launchers = [...files].filter(([path, text]) => path !== 'server/providers/discovery.ts'
    && [...text.matchAll(/findExecutable\)?\(\s*([^,)]+)/g)].some(match => !["'gh'", "'git'"].includes(match[1]!.trim()))).map(([path]) => path).sort();
  assert.deepEqual(launchers, ['server/auto-prompt/native.ts', 'server/master/first-reply.ts', 'server/runs/manager.ts', 'server/updates/tools.ts']);
  assert.match(files.get('server/master/first-reply.ts')!, /resolveModel\(this\.options\.stateDir, 'voice\.firstReply'\)/);
});

test('every one-shot judgment takes its provider and model from a role', async () => {
  const files = await sources();
  const callers = [...files].filter(([path, text]) => path !== 'server/auto-prompt/native.ts' && /runAutoPromptModel|AutoPromptModelRequest/.test(text) && /systemPrompt/.test(text));
  assert.deepEqual(callers.map(([path]) => path).sort(), ['server/auto-prompt/manager.ts', 'server/permissions/reviewer.ts', 'server/public-agents/service.ts', 'server/sessions/compaction/service.ts', 'server/sessions/tasks.ts', 'server/skills/advisor.ts',
    'server/slack/service.ts', 'server/triggers/github-coordinator.ts']);
  for (const [path, text] of callers) {
    assert.match(text, /resolveModel\(|reviewModel\(/, `${relative(root, path)} resolves a role`);
    assert.doesNotMatch(text, /\b(provider|model):[^{}]{0,200}systemPrompt/, `${path} spreads the resolved model instead of naming one`);
  }
});
