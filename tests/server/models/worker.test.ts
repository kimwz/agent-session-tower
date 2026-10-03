import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newWorkerSession } from '../../../server/models/worker.js';
import { initialModelSettings } from '../../../shared/models.js';
import { saveModelSettings } from '../../../server/models/settings.js';
import { parseCreateSession, parseAutoPrompt } from '../../../server/http/requests.js';

test('new-session admission resolves the role and explicit fields, leaving ordinary creates alone', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-worker-model-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = initialModelSettings();
  settings.roles['master.worker'] = { provider: 'claude', claude: { model: 'sonnet', effort: 'high' }, codex: { model: 'gpt-6.1-sol', effort: 'low' } };
  await saveModelSettings(directory, settings);
  const base = { cwd: directory, prompt: 'work' };
  assert.throws(() => parseCreateSession(base), /선택/);
  const role = { ...base, modelRole: 'master.worker' };
  assert.deepEqual(await newWorkerSession(directory, parseCreateSession(role)), { ...base, provider: 'claude', model: 'sonnet', effort: 'high' });
  assert.deepEqual(await newWorkerSession(directory, parseCreateSession({ ...role, provider: 'codex', effort: 'xhigh' })), { ...base, provider: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
  assert.deepEqual(await newWorkerSession(directory, parseCreateSession({ ...role, model: 'chosen' })), { ...base, provider: 'claude', model: 'chosen', effort: 'high' });
  assert.deepEqual(await newWorkerSession(directory, parseCreateSession({ ...base, provider: 'codex' })), { ...base, provider: 'codex' });
  await assert.rejects(newWorkerSession(directory, { ...base, modelRole: 'master.worker', effort: 'minimal' }), /reasoning effort/);
  for (const extra of [{ provider: 'bad' }, { model: '' }, { effort: '' }, { modelRole: 'reviewer.codex' }]) assert.throws(() => parseCreateSession({ ...role, ...extra }), { kind: 'invalid' });
  assert.equal(parseAutoPrompt({ ...role, requestId: '11111111-1111-4111-8111-111111111111' }).provider, undefined);
});
