import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { RunManager } from '../../../server/runs/manager.js';
import type { CodexStdioOptions } from '../../../server/runs/codex-stdio.js';

test('every Claude and Codex turn finds the launch shims first in its PATH and knows where their marks go', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tower-shim-env-'));
  const stateDir = join(directory, 'state');
  await mkdir(stateDir, { recursive: true });
  const envs: NodeJS.ProcessEnv[] = [];
  const codex: CodexStdioOptions[] = [];
  const launchMarks = { shims: join(stateDir, 'runtime', 'launch-shims'), marks: join(stateDir, 'launch-marks') };
  const manager = new RunManager({ stateDir, getSession: () => undefined, refreshSessions: async () => {}, pollMs: 60_000, launchMarks,
    env: { PATH: `/usr/bin${delimiter}${launchMarks.shims}${delimiter}/bin`, CLAUDE_CODE_SESSION_ID: 'the-parent-of-tower' },
    findExecutable: async provider => `/fixture/${provider}`,
    spawnProcess: ((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { envs.push(options.env); throw new Error('Fixtures never start providers.'); }) as never,
    openCodexStdio: async options => { codex.push(options); throw new Error('Fixtures never start providers.'); } });
  await manager.start();
  t.after(async () => { await manager.close(); await rm(directory, { recursive: true, force: true }); });
  const settled = async (id: string) => { for (let i = 0; i < 200 && manager.list().find(run => run.id === id)?.status === 'queued'; i++) await new Promise(resolve => setTimeout(resolve, 10)); };
  const claude = await manager.create({ provider: 'claude', cwd: directory, prompt: 'x' }, { origin: { kind: 'owner' } });
  await settled(claude.run.id);
  const other = await manager.create({ provider: 'codex', cwd: directory, prompt: 'x' }, { origin: { kind: 'owner' } });
  await settled(other.run.id);
  for (const env of [envs[0]!, codex[0]!.env!]) {
    const path = env.PATH!.split(delimiter);
    assert.equal(path[0], launchMarks.shims);
    assert.equal(path.filter(dir => dir === launchMarks.shims).length, 1);
    assert.equal(env.TOWER_LAUNCH_MARKS, launchMarks.marks);
    assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined, 'a turn never claims to be started by whatever started Tower');
  }
});
