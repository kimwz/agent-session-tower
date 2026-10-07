import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNativeRetentionAdapter, RetentionProviderBlockedError } from '../../../server/sessions/retention/provider.js';
import type { RetentionRecord } from '../../../server/sessions/retention/policy.js';
import type { RetentionManifest } from '../../../server/sessions/retention/types.js';

function record(filePath: string, provider: 'claude' | 'codex' = 'claude'): RetentionRecord {
  return {
    kind: 'subagent',
    session: {
      id: `${provider}:child`, nativeId: 'child', provider, title: 'fixture', cwd: '/', project: 'fixture',
      status: 'completed', statusReason: 'fixture', createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z', lastMessage: 'done', messageCount: 1,
      isSubagent: true, resumable: false, filePath,
    },
  };
}

test('native providers never remove or restore transcripts without a verified contract', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tower-retention-provider-'));
  const root = await realpath(temporary);
  try {
    const file = join(root, 'child.jsonl');
    await writeFile(file, '{"fixture":true}\n');
    const adapter = createNativeRetentionAdapter({ claude: [root], codex: [root] });
    for (const provider of ['claude', 'codex'] as const) {
      assert.equal(adapter.capability(provider).status, 'blocked');
      assert.ok(adapter.capability(provider).reason);
      const source = record(file, provider);
      await assert.rejects(adapter.reserve({ rootId: source.session.id, ids: [source.session.id], reason: 'child-expired', revisions: {} }, [source]), RetentionProviderBlockedError);
      const manifest: RetentionManifest = {
        version: 1, id: 'fixture', createdAt: '2026-01-01T00:00:00Z', reason: 'child-expired',
        sessions: [{ id: source.session.id, nativeId: 'child', provider, title: 'fixture' }], files: [],
      };
      await assert.rejects(adapter.restore!(manifest, 'fixture-operation'), RetentionProviderBlockedError);
      assert.equal(await readFile(file, 'utf8'), '{"fixture":true}\n');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('read-only backup discovery validates roots, symlink ancestors and alias identity', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'tower-retention-provider-'));
  const base = await realpath(temporary);
  try {
    const root = join(base, 'sessions');
    const outside = join(base, 'sessions-other');
    await mkdir(root); await mkdir(outside);
    const file = join(root, 'child.jsonl');
    await writeFile(file, 'fixture');
    const adapter = createNativeRetentionAdapter({ claude: [root], codex: [root] });
    const first = record(file);
    const alias = record(file); alias.session.id = 'claude:monitor-child';
    assert.deepEqual(await adapter.files([first, alias]), [{ path: file, root, provider: 'claude', nativeId: 'child' }]);
    alias.session.nativeId = 'different';
    await assert.rejects(adapter.files([first, alias]), /Conflicting transcript identity/);
    await assert.rejects(adapter.files([record(join(outside, 'child.jsonl'))]), /outside native roots/);
    await assert.rejects(adapter.files([record('relative.jsonl')]), /Missing absolute/);
    const linked = join(root, 'linked');
    await symlink(outside, linked);
    await writeFile(join(outside, 'child.jsonl'), 'outside');
    await assert.rejects(adapter.files([record(join(linked, 'child.jsonl'))]), /Unsafe transcript path/);
    assert.equal(await readFile(file, 'utf8'), 'fixture');
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
