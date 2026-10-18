import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SessionService } from '../../../server/sessions/service.js';
import { walk } from '../../../server/sessions/parser.js';
import { openTranscript, transcriptChunks } from '../../../server/sessions/transcript-file.js';
import { transcriptMentions } from '../../../server/worktrees/transcripts.js';
import { RetentionArchive } from '../../../server/sessions/retention/archive.js';

// Codex's rollout compression worker replaces a rollout it has not touched for a while with `<name>.jsonl.zst` (same
// mtime) and writes `<name>.jsonl` again when the conversation goes on.
const id = '33333333-3333-4333-8333-333333333333';
const at = (minute: number) => `2026-10-01T00:0${minute}:00.000Z`;
const row = (type: string, payload: Record<string, unknown>, timestamp: string) => ({ type, payload, timestamp });
const message = (role: string, text: string, timestamp: string) => row('response_item', { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }], phase: role === 'user' ? undefined : 'final' }, timestamp);
const content = [
  row('session_meta', { id, cwd: '/work/project', timestamp: at(0) }, at(0)),
  row('event_msg', { type: 'task_started' }, at(1)),
  message('user', 'Fix the flaky login test', at(1)),
  message('assistant', 'The login test waits for the button now.', at(2)),
  row('event_msg', { type: 'task_complete' }, at(3)),
].map(value => JSON.stringify(value)).join('\n') + '\n';
const ARCHIVED_AT = 1_790_000_000;

async function compress(path: string, text = content): Promise<void> {
  await writeFile(`${path}.zst`, zstdCompressSync(Buffer.from(text)));
  await utimes(`${path}.zst`, ARCHIVED_AT, ARCHIVED_AT);
}

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'tower-compressed-transcripts-')));
  const codexHome = join(directory, 'codex'), claudeHome = join(directory, 'claude');
  await Promise.all([mkdir(join(codexHome, 'sessions'), { recursive: true }), mkdir(join(codexHome, 'archived_sessions'), { recursive: true }), mkdir(join(claudeHome, 'projects'), { recursive: true })]);
  const service = new SessionService({ codexHome, claudeHome });
  t.after(async () => { service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, service, rollout: join(codexHome, 'sessions', `rollout-2026-10-01T00-00-00-${id}.jsonl`) };
}

const view = (service: SessionService) => {
  const session = service.get(`codex:${id}`)!;
  const { filePath: _, ...rest } = session;
  return rest;
};

test('a compressed Codex rollout is listed, read and searched as its JSONL is', async t => {
  const plain = await fixture(t);
  await writeFile(plain.rollout, content);
  await plain.service.refresh();
  const zipped = await fixture(t);
  await compress(zipped.rollout);
  await zipped.service.refresh();

  assert.deepEqual(view(zipped.service), view(plain.service));
  assert.equal(zipped.service.get(`codex:${id}`)?.filePath, `${zipped.rollout}.zst`);
  assert.equal(zipped.service.get(`codex:${id}`)?.title, 'Fix the flaky login test');
  assert.deepEqual(await zipped.service.detail(`codex:${id}`), { ...(await plain.service.detail(`codex:${id}`))!, session: zipped.service.get(`codex:${id}`)! });
  const page = (await zipped.service.detail(`codex:${id}`, undefined, 1))!;
  assert.deepEqual(page.messages.map(item => item.text), ['The login test waits for the button now.']);
  assert.deepEqual((await zipped.service.detail(`codex:${id}`, page.nextBefore, 1))!.messages.map(item => item.text), ['Fix the flaky login test']);
  const search = (service: SessionService) => service.search(`codex:${id}`, { terms: ['login'], keep: 10 }).then(result => result && { ...result, file: 0 });
  assert.deepEqual(await search(zipped.service), await search(plain.service));
  assert.equal((await search(zipped.service))?.count, 2);

  const records = (service: SessionService) => service.retentionRecords().records.map(record => ({ latestTaskEndedAt: record.latestTaskEndedAt, lastActivityAt: record.lastActivityAt }));
  assert.deepEqual(records(zipped.service), records(plain.service));
  assert.equal(records(zipped.service)[0]?.latestTaskEndedAt, at(3));
  assert.equal(zipped.service.retentionRecords().complete, true);
});

test('a compressed rollout beside its JSONL is one session, the JSONL; an unchanged one is not read again', async t => {
  const { service, rollout } = await fixture(t);
  await compress(rollout);
  await service.refresh();
  assert.equal(service.list().length, 1);
  // Unchanged on disk (inode, size, mtime): the scan does not read it again, so bytes it could not read go unnoticed.
  const before = await stat(`${rollout}.zst`);
  await writeFile(`${rollout}.zst`, Buffer.alloc(before.size));
  await utimes(`${rollout}.zst`, ARCHIVED_AT, ARCHIVED_AT);
  await service.refresh();
  assert.equal(service.get(`codex:${id}`)?.title, 'Fix the flaky login test');
  assert.equal(service.retentionRecords().complete, true);

  // Codex goes on with the conversation: it writes the JSONL, and the compressed copy may still be there for a moment.
  await compress(rollout);
  await writeFile(rollout, content + JSON.stringify(message('user', 'And the signup test', at(4))) + '\n');
  await service.refresh();
  assert.equal(service.list().length, 1);
  assert.equal(service.get(`codex:${id}`)?.filePath, rollout);
  assert.equal(service.get(`codex:${id}`)?.lastMessage, 'And the signup test');
  assert.deepEqual(await walk(join(rollout, '..'), 6, undefined, { compressed: true }), [rollout]);
  await unlink(`${rollout}.zst`);
  await service.refresh();
  assert.equal(service.list().length, 1);
});

test('compressed transcripts are read from memory, kept while unchanged, and streamed for the worktree scan', async t => {
  const { rollout } = await fixture(t);
  await compress(rollout);
  const first = await openTranscript(`${rollout}.zst`);
  assert.equal(first.size, Buffer.byteLength(content));
  const buffer = Buffer.alloc(12);
  assert.equal((await first.read(buffer, 0, 12, 0)).bytesRead, 12);
  assert.equal(buffer.toString(), content.slice(0, 12));
  assert.equal((await first.read(buffer, 0, 12, first.size)).bytesRead, 0);
  await first.close();
  // Kept: the same file (inode, size, mtime) reads as before without being decompressed again.
  const info = await stat(`${rollout}.zst`);
  await writeFile(`${rollout}.zst`, Buffer.alloc(info.size));
  await utimes(`${rollout}.zst`, ARCHIVED_AT, ARCHIVED_AT);
  assert.equal((await openTranscript(`${rollout}.zst`)).size, Buffer.byteLength(content));
  // Changed: read again.
  await compress(rollout, 'other\n');
  assert.equal((await openTranscript(`${rollout}.zst`)).size, 6);
  await compress(rollout);
  assert.deepEqual([...(await transcriptMentions(`${rollout}.zst`, ['login'])).found], ['login']);
  const none = await transcriptMentions(`${rollout}.zst`, ['signup']);
  assert.deepEqual([...none.found], []);
  assert.equal(none.end, Buffer.byteLength(content));
});

test('an archived original retention keeps stays out of the list after Codex compressed it', async t => {
  const { service, directory } = await fixture(t);
  const archived = join(directory, 'codex', 'archived_sessions', `rollout-2026-10-01T00-00-00-${id}.jsonl`);
  await compress(archived);
  service.setColdRegistry([join(directory, 'codex', 'sessions', `rollout-2026-10-01T00-00-00-${id}.jsonl`), archived], [`codex:${id}`]);
  await service.refresh(true);
  assert.equal(service.list().length, 0);
  assert.equal(service.retentionRecords().records.length, 0);
});

test('the worktree scan goes on where it ended in a JSONL, and reads a compressed transcript from its start, characters of any width included', async t => {
  const { rollout } = await fixture(t);
  const add = (path: string) => JSON.stringify(message('assistant', `만들었습니다 — git worktree add ${path}`, at(5))) + '\n';
  const text = content + add('/work/wt-한글') + add('/work/wt-two');
  await writeFile(rollout, text);
  await compress(rollout, text);
  for (const file of [rollout, `${rollout}.zst`]) {
    const first = await transcriptMentions(file, ['wt-한글']);
    assert.deepEqual([...first.found], ['wt-한글']);
    const rest = await transcriptMentions(file, ['wt-한글', 'wt-two'], first.end);
    // A compressed transcript may have been replaced whole since: a place in it is not kept.
    assert.deepEqual([...rest.found], file === rollout ? ['wt-two'] : ['wt-한글', 'wt-two']);
    assert.equal((await transcriptMentions(file, ['nothing'], rest.end)).end, Buffer.byteLength(text));
  }
  const plain = await transcriptMentions(rollout, ['wt-한글']), zipped = await transcriptMentions(`${rollout}.zst`, ['wt-한글']);
  assert.equal(zipped.end, plain.end);
});

test('a cold bundle of a compressed transcript previews the JSONL it holds', async t => {
  const { directory, rollout } = await fixture(t);
  await compress(rollout);
  const archive = new RetentionArchive(join(directory, 'bundles'), [join(directory, 'codex', 'sessions')]);
  await archive.start();
  const session = { id: `codex:${id}`, nativeId: id, provider: 'codex' as const, title: 'fixture', cwd: '/work/project', project: 'project', status: 'completed' as const, statusReason: '',
    createdAt: at(0), updatedAt: at(3), lastMessage: '', messageCount: 2, isSubagent: false, resumable: true, filePath: `${rollout}.zst` };
  const manifest = await archive.create('a'.repeat(64), { rootId: session.id, ids: [session.id], reason: 'explicit-archive', revisions: {} }, [{ session, kind: 'parent' }],
    [{ path: `${rollout}.zst`, root: join(directory, 'codex', 'sessions'), nativeId: id, provider: 'codex' }]);
  const whole = await archive.read(manifest.id, manifest.files[0]!.name);
  assert.deepEqual({ text: whole.text, truncated: whole.truncated }, { text: content, truncated: false });
  const part = await archive.read(manifest.id, manifest.files[0]!.name, 40);
  assert.deepEqual({ text: part.text, truncated: part.truncated }, { text: content.slice(0, 40), truncated: true });
});

test('one pass over a compressed transcript comes in small chunks, whatever its size', async t => {
  const { rollout } = await fixture(t);
  // A pass hands its chunks to readline, which makes each a string: one chunk of a large transcript would not fit.
  const text = content.repeat(4000);
  await compress(rollout, text);
  const sizes: number[] = [];
  for await (const chunk of transcriptChunks(`${rollout}.zst`)) sizes.push(chunk.length);
  assert.equal(sizes.reduce((sum, size) => sum + size, 0), Buffer.byteLength(text));
  assert.ok(sizes.length > 1 && Math.max(...sizes) <= 128 * 1024);
  const middle: Buffer[] = [];
  for await (const chunk of transcriptChunks(`${rollout}.zst`, 100, 300_000)) middle.push(chunk);
  assert.equal(Buffer.concat(middle).toString(), Buffer.from(text).subarray(100, 300_000).toString());
});
