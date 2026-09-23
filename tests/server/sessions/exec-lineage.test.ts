import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../../../server/sessions/service.js';
import { parseExecLaunch, promptDigest } from '../../../server/sessions/exec-lineage.js';

const lines = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const at = (second: number) => `2026-09-23T01:50:${String(second).padStart(2, '0')}.000Z`;
const command = 'cd /work/review && timeout 580 codex exec -s read-only "Review this exact diff." 2>&1 | tail -60';
const launch = { type: 'assistant', sessionId: 'parent', cwd: '/work/main', timestamp: at(18), message: { content: [{ type: 'tool_use', name: 'Bash', id: 'call', input: { command } }] } };
const result = { type: 'user', timestamp: at(40), message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'done' }] } };
const child = (id: string, prompt = 'Review this exact diff.', second = 21) => lines(
  { type: 'session_meta', timestamp: at(second), payload: { id, timestamp: at(second), cwd: '/work/review', source: 'exec', thread_source: 'user' } },
  { type: 'response_item', timestamp: at(second), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
);

test('literal exec parsing rejects resume, echoed commands, substitutions, and ambiguous shell flow', () => {
  assert.equal(parseExecLaunch(command, '/work/main')?.cwd, '/work/review');
  assert.equal(parseExecLaunch(String.raw`codex exec "literal \q"`, '/work')?.prompt, promptDigest(String.raw`literal \q`));
  for (const bad of ['echo "codex exec test"', 'codex exec resume abc test', 'codex exec "$(cat prompt)"', 'codex exec review', 'codex exec\n"Review this exact diff."', 'codex exec #review']) {
    assert.equal(parseExecLaunch(bad, '/work'), undefined, bad);
  }
});

test('cross-provider lineage is unique, projected in detail, survives restart, and clears after truncation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-exec-lineage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude');
  const cp = join(codexHome, 'sessions'), cl = join(claudeHome, 'projects', 'main');
  await Promise.all([mkdir(cp, { recursive: true }), mkdir(cl, { recursive: true })]);
  const parentPath = join(cl, 'parent.jsonl');
  await Promise.all([writeFile(parentPath, lines(launch)), writeFile(join(cp, 'one.jsonl'), child('one')), writeFile(join(cp, 'unrelated.jsonl'), child('unrelated', 'Other task'))]);
  const options = { codexHome, claudeHome, inspectProcesses: async () => ({ claude: new Map(), codex: new Set<string>(), providerRunning: { claude: false, codex: false } }) };
  const service = new SessionService(options);
  await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, 'claude:parent');
  assert.equal(service.get('codex:one')?.parentLink, 'exec');
  assert.equal(service.get('codex:unrelated')?.isSubagent, false);
  assert.equal((await service.detail('codex:one'))?.session.parentId, 'claude:parent');
  await appendFile(parentPath, lines(result));
  await service.refresh();
  assert.equal(service.get('codex:one')?.isSubagent, true);
  const restarted = new SessionService(options); await restarted.refresh();
  assert.equal(restarted.get('codex:one')?.parentId, 'claude:parent');
  await writeFile(join(cp, 'two.jsonl'), child('two'));
  await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, undefined, 'ambiguous launch must not attach either candidate');
  assert.equal(service.get('codex:two')?.parentId, undefined);
  await rm(join(cp, 'two.jsonl')); await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, 'claude:parent');
  await writeFile(join(cl, 'other.jsonl'), lines({ ...launch, sessionId: 'other' })); await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, undefined, 'two identical launches are ambiguous');
  await rm(join(cl, 'other.jsonl'));
  await writeFile(join(cp, 'late.jsonl'), child('late', 'Review this exact diff.', 45));
  await writeFile(join(cp, 'native.jsonl'), child('native').replace('"source":"exec"', '"source":"exec","parent_thread_id":"native-parent"'));
  await writeFile(join(cp, 'manual.jsonl'), child('manual').replace('"source":"exec"', '"source":"cli"'));
  await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, 'claude:parent');
  assert.equal(service.get('codex:late')?.parentId, undefined, 'completed call bounds launch timing');
  assert.equal(service.get('codex:native')?.parentId, 'codex:native-parent');
  assert.equal(service.get('codex:manual')?.parentId, undefined);
  await writeFile(parentPath, lines({ type: 'user', sessionId: 'parent', timestamp: at(10), message: { content: 'unrelated' } }));
  await service.refresh();
  assert.equal(service.get('codex:one')?.parentId, undefined);
  assert.equal(service.get('codex:one')?.isSubagent, false);
});

const backgroundCommand = 'cd /Users/planetariumhq/Workspace/g2-sync.wt-review-833 && codex exec -s read-only "Review this exact diff." > /tmp/codex-833.txt 2>&1; echo exit=$? >> /tmp/codex-833.txt';

test('first invocation preserves provenance independently of later status and cleanup commands', () => {
  assert.deepEqual(parseExecLaunch(backgroundCommand, '/work/main'), {
    cwd: '/Users/planetariumhq/Workspace/g2-sync.wt-review-833', prompt: promptDigest('Review this exact diff.'),
  });
  assert.equal(parseExecLaunch('codex exec "Review" > /tmp/review.txt', '/work')?.prompt, promptDigest('Review'));
  for (const bad of [
    backgroundCommand.replace('> /tmp/codex-833.txt 2>&1', '> /tmp/$(whoami) 2>&1'),
    'codex exec Review > /tmp/result | other',
    'codex exec resume abc Review > /tmp/result',
  ]) assert.equal(parseExecLaunch(bad, '/work'), undefined, bad);
});

test('absolute executables and quoted multiline prompts survive arbitrary post-command reporting', () => {
  const prompt = 'Review this diff.\nKeep "quotes", ; separators, && and | literal.';
  const quoted = JSON.stringify(prompt).replaceAll('\\n', '\n');
  const first = `/Users/example/.local/bin/codex exec --sandbox read-only -C /work/review ${quoted} > /tmp/review.log 2>&1`;
  for (const suffix of ['\necho "EXIT:$?"', '; echo exit=$(whoami)', ' && cleanup', ' || report_failure', '\n# status\necho done']) {
    assert.deepEqual(parseExecLaunch(first + suffix, '/work'), { cwd: '/work/review', prompt: promptDigest(prompt) });
  }
  for (const bad of [
    'echo ignored; codex exec Review',
    'if true; then codex exec Review; fi',
    '(codex exec Review)',
    'false && codex exec Review',
    'cd /work; codex exec Review',
    'codex exec "$(echo Review)"; echo done',
    '/opt/not-codex exec Review',
    './codex exec Review',
    'codex exec "unterminated; echo done',
  ]) assert.equal(parseExecLaunch(bad, '/work'), undefined, bad);
});

test('background acknowledgment before child creation does not end the bounded launch window', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'tower-background-lineage-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const codexHome = join(dir, 'codex'), claudeHome = join(dir, 'claude');
  const cp = join(codexHome, 'sessions'), cl = join(claudeHome, 'projects', 'main');
  await Promise.all([mkdir(cp, { recursive: true }), mkdir(cl, { recursive: true })]);
  const backgroundLaunch = { ...launch, message: { content: [{ type: 'tool_use', name: 'Bash', id: 'call', input: { command: backgroundCommand, run_in_background: true } }] } };
  const ack = { ...result, timestamp: at(19), message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'Command running in background with ID: task. You will be notified when it completes.' }] } };
  const childRows = child('one').replace('/work/review', '/Users/planetariumhq/Workspace/g2-sync.wt-review-833');
  await Promise.all([
    writeFile(join(cl, 'parent.jsonl'), lines(backgroundLaunch, ack)),
    writeFile(join(cp, 'one.jsonl'), childRows),
    writeFile(join(cp, 'late.jsonl'), childRows.replaceAll('"one"', '"late"').replaceAll('01:50:21', '02:21:21')),
  ]);
  const options = { codexHome, claudeHome, inspectProcesses: async () => ({ claude: new Map(), codex: new Set<string>(), providerRunning: { claude: false, codex: false } }) };
  for (const launchCommand of [backgroundCommand, '/Users/example/.local/bin/codex exec --sandbox read-only -C /Users/planetariumhq/Workspace/g2-sync.wt-review-833 "Review this exact diff." > /tmp/codex-833.log 2>&1\necho "EXIT:$?"']) {
    backgroundLaunch.message.content[0]!.input.command = launchCommand;
    await writeFile(join(cl, 'parent.jsonl'), lines(backgroundLaunch, ack));
    const service = new SessionService(options); await service.refresh();
    assert.equal(service.get('codex:one')?.parentId, 'claude:parent');
    assert.equal(service.get('codex:late')?.parentId, undefined, 'background launches retain the 30 minute bound');
  }
});
