import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService, parseMessages } from '../server/sessions.js';
import { parseCodexOpenFiles } from '../server/processes.js';

const rootId = '11111111-1111-4111-8111-111111111111';
const childId = '22222222-2222-4222-8222-222222222222';
const old = '2025-01-01T00:00:00.000Z';
const now = () => new Date().toISOString();
const row = (type: string, payload: Record<string, unknown>, timestamp = now()) => ({ type, payload, timestamp });
const codexMessage = (role: string, content: string, timestamp = now(), phase?: string) => row('response_item', {
  type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: content }], phase,
}, timestamp);
const lines = (rows: unknown[]) => rows.map((value) => JSON.stringify(value)).join('\n') + '\n';

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-monitor-sessions-'));
  const codexHome = join(directory, 'codex');
  const claudeHome = join(directory, 'claude');
  await Promise.all([mkdir(join(codexHome, 'sessions'), { recursive: true }), mkdir(join(claudeHome, 'projects', 'test'), { recursive: true })]);
  const service = new SessionService({ codexHome, claudeHome });
  t.after(async () => { service.stop(); await rm(directory, { recursive: true, force: true }); });
  return { directory, codexHome, claudeHome, service, codex: join(codexHome, 'sessions', `rollout-${rootId}.jsonl`), claude: join(claudeHome, 'projects', 'test', `${rootId}.jsonl`) };
}

test('Codex starts, completes and resumes a real turn using append-only updates', async (t) => {
  const { service, codex } = await fixture(t);
  await writeFile(codex, lines([
    row('session_meta', { id: rootId, cwd: '/work/project', timestamp: now() }),
    row('event_msg', { type: 'task_started' }),
    codexMessage('user', 'Fix the missing login button'),
    codexMessage('assistant', 'Investigating the navigation.', now(), 'commentary'),
  ]));
  await service.refresh();
  assert.equal(service.list().length, 1);
  assert.equal(service.get(`codex:${rootId}`)?.status, 'working');
  assert.equal(service.get(`codex:${rootId}`)?.title, 'Fix the missing login button');
  assert.equal(service.get(`codex:${rootId}`)?.project, 'project');
  await appendFile(codex, lines([codexMessage('assistant', 'The button is restored.', now(), 'final'), row('event_msg', { type: 'task_complete' })]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.status, 'completed');
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 3);
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 3, 'unchanged files must not duplicate messages');
  await appendFile(codex, lines([row('event_msg', { type: 'task_started' }), codexMessage('user', 'Add a keyboard shortcut') ]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.status, 'working');
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 4);
});

test('freshly copied old unfinished transcripts never appear working', async (t) => {
  const { service, codex } = await fixture(t);
  await writeFile(codex, lines([row('session_meta', { id: rootId, cwd: '/old', timestamp: old }, old), row('event_msg', { type: 'task_started' }, old), codexMessage('user', 'An old abandoned task', old)]));
  await service.refresh();
  const session = service.get(`codex:${rootId}`)!;
  assert.equal(session.status, 'error');
  assert.equal(session.updatedAt, old, 'file birthtime must not manufacture recent activity');
});

test('Codex copied parent metadata cannot replace subagent identity or finish its new turn', async (t) => {
  const { service, codex } = await fixture(t);
  const current = now();
  await writeFile(codex, lines([
    row('session_meta', { id: childId, session_id: rootId, parent_thread_id: rootId, timestamp: current, cwd: '/work', agent_nickname: 'Ada', source: { subagent: { thread_spawn: { parent_thread_id: rootId } } } }, current),
    row('session_meta', { id: rootId, timestamp: old, cwd: '/old' }, old),
    codexMessage('user', 'Copied parent prompt', old),
    row('event_msg', { type: 'task_complete' }, old),
    row('event_msg', { type: 'task_started' }, current),
    codexMessage('user', 'Review authentication', current),
  ]));
  await service.refresh();
  const session = service.get(`codex:${childId}`)!;
  assert.equal(service.get(`codex:${rootId}`), undefined);
  assert.equal(session.parentId, `codex:${rootId}`);
  assert.equal(session.agentName, 'Ada');
  assert.equal(session.cwd, '/work');
  assert.equal(session.title, 'Review authentication');
  assert.equal(session.status, 'working');
  assert.equal(session.messageCount, 1);
  assert.deepEqual((await service.detail(session.id))?.messages.map(message => message.text), ['Review authentication']);
});

test('Codex explicit child history boundary excludes copied records with rewritten timestamps from every page', async t => {
  const { service, codexHome, claudeHome, codex } = await fixture(t);
  const created = now();
  const request = new Date(Date.parse(created) + 1000).toISOString();
  const completed = new Date(Date.parse(created) + 2000).toISOString();
  const metadata = row('session_meta', { id: childId, timestamp: created, cwd: '/work/child', agent_nickname: 'Ada',
    source: { subagent: { thread_spawn: { parent_thread_id: rootId } } }, subagent_history_start_ordinal: 6 }, created);
  const inherited = [metadata, row('session_meta', { id: rootId, timestamp: old }, old),
    codexMessage('user', 'Copied parent prompt', created), codexMessage('assistant', 'Copied parent answer', created, 'final_answer'),
    row('event_msg', { type: 'task_complete' }, created), row('turn_context', { model: 'parent-model', cwd: '/parent' }, created)];
  await writeFile(codex, lines(inherited));
  await service.refresh();
  assert.equal(service.get(`codex:${childId}`)?.messageCount, 0, 'a partial child file never exposes inherited messages');
  assert.equal(service.get(`codex:${childId}`)?.lastCompletedAt, undefined);
  assert.deepEqual((await service.detail(`codex:${childId}`))?.messages, []);
  const own = [row('event_msg', { type: 'task_started' }, request),
    row('response_item', { type: 'agent_message', author: '/root', recipient: '/root/reviewer', content: [{ type: 'input_text', text: 'Review the login implementation' }] }, request),
    codexMessage('user', 'Check authentication', request), codexMessage('assistant', 'Checking the login flow.', request, 'commentary'),
    codexMessage('assistant', 'Authentication checked.', completed, 'final_answer')];
  await appendFile(codex, lines(own));
  await service.refresh();
  const expected = ['Review the login implementation', 'Check authentication', 'Checking the login flow.', 'Authentication checked.'];
  const session = service.get(`codex:${childId}`)!;
  assert.equal(session.title, 'Check authentication');
  assert.equal(session.cwd, '/work/child');
  assert.equal(session.model, undefined, 'copied context cannot overwrite child metadata');
  assert.equal(session.messageCount, 4);
  assert.equal(session.lastRequestAt, request);
  assert.equal(session.lastCompletedAt, completed);
  const received: string[] = [];
  let before: number | undefined;
  do {
    const page = (await service.detail(session.id, before, 1))!;
    received.unshift(...page.messages.map(message => message.text));
    if (before !== undefined && page.nextBefore !== undefined) assert.ok(page.nextBefore < before);
    before = page.nextBefore;
  } while (before !== undefined);
  assert.deepEqual(received, expected);
  const reloaded = new SessionService({ codexHome, claudeHome });
  await reloaded.refresh();
  assert.deepEqual((await reloaded.detail(session.id))?.messages.map(message => message.text), expected);
  await writeFile(codex, lines([row('session_meta', { ...metadata.payload, subagent_history_start_ordinal: 1 }, created),
    codexMessage('user', 'Rotated child request', request)]));
  await service.refresh();
  assert.equal(service.get(session.id)?.messageCount, 1);
  assert.equal(service.get(session.id)?.lastCompletedAt, undefined);
  assert.deepEqual((await service.detail(session.id))?.messages.map(message => message.text), ['Rotated child request']);
});

test('user-created Codex forks remain independent sessions even with parent metadata', async t => {
  const { service, codex } = await fixture(t);
  await writeFile(codex, lines([row('session_meta', { id: childId, forked_from_id: rootId, parent_thread_id: rootId,
    source: 'vscode', thread_source: 'user', timestamp: now() }), codexMessage('user', 'My independent task')]));
  await service.refresh();
  const session = service.get(`codex:${childId}`)!;
  assert.equal(session.isSubagent, false);
  assert.equal(session.resumable, true);
  assert.equal(session.parentId, `codex:${rootId}`);
  assert.equal((await service.detail(session.id))?.messages[0]?.text, 'My independent task');
});

test('Codex ordering changes only for human requests and terminal events, never streaming activity or file mtime', async t => {
  const { service, codexHome, codex } = await fixture(t);
  const timestamp = Date.now();
  const at = (seconds: number) => new Date(timestamp + seconds * 1000).toISOString();
  const other = join(codexHome, 'sessions', `rollout-${childId}.jsonl`);
  await writeFile(codex, lines([row('session_meta', { id: rootId, timestamp: at(0) }, at(0)), codexMessage('user', 'Older task', at(1))]));
  await writeFile(other, lines([row('session_meta', { id: childId, timestamp: at(0) }, at(0)), codexMessage('user', 'Newer task', at(2))]));
  await service.refresh();
  const expectedOrder = [`codex:${childId}`, `codex:${rootId}`];
  assert.deepEqual(service.list().map(session => session.id), expectedOrder);
  await appendFile(codex, lines([
    codexMessage('assistant', 'Streaming progress', at(3), 'commentary'),
    row('response_item', { type: 'function_call', name: 'exec', arguments: '{}' }, at(4)),
    row('response_item', { type: 'function_call_output', output: 'Completed a tool call' }, at(5)),
    codexMessage('user', '# AGENTS.md instructions\nInjected configuration', at(6)),
    row('event_msg', { type: 'token_count' }, at(7)),
    row('event_msg', { type: 'task_started' }, at(8)),
    row('event_msg', { type: 'error', will_retry: true }, at(9)),
  ]));
  await service.refresh(true);
  let session = service.get(`codex:${rootId}`)!;
  assert.equal(session.lastRequestAt, at(1));
  assert.equal(session.lastCompletedAt, undefined);
  assert.equal(session.updatedAt, at(9));
  assert.deepEqual(service.list().map(session => session.id), expectedOrder);
  await appendFile(codex, lines([codexMessage('assistant', 'Finished.', at(10), 'final')]));
  await service.refresh();
  session = service.get(`codex:${rootId}`)!;
  assert.equal(session.lastCompletedAt, at(10));
  assert.deepEqual(service.list().map(session => session.id), expectedOrder.toReversed());
  await appendFile(codex, lines([codexMessage('user', 'Follow up', at(11)), row('event_msg', { type: 'turn_aborted' }, at(12))]));
  await service.refresh();
  assert.equal(service.get(session.id)?.lastRequestAt, at(11));
  assert.equal(service.get(session.id)?.lastCompletedAt, at(12));
  await appendFile(codex, lines([row('event_msg', { type: 'error' }, at(13))]));
  await service.refresh();
  assert.equal(service.get(session.id)?.lastCompletedAt, at(13));
});

test('Claude tool results, injected context and partial responses do not change request or completion times', async t => {
  const { service, claude } = await fixture(t);
  const timestamp = Date.now();
  const at = (seconds: number) => new Date(timestamp + seconds * 1000).toISOString();
  const message = (type: string, content: unknown, second: number, stop_reason?: string) => ({ type, sessionId: rootId,
    timestamp: at(second), message: { role: type, content, stop_reason } });
  await writeFile(claude, lines([message('user', 'Check the migration', 1),
    message('assistant', [{ type: 'text', text: 'Working' }], 2),
    message('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 3, 'tool_use'),
    message('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'Done' }], 4),
    message('user', '<system-reminder>Injected context</system-reminder>', 5),
    { ...message('assistant', 'Synthetic result', 6, 'end_turn'), isMeta: true },
    { type: 'system', subtype: 'stop_hook_summary', preventedContinuation: true, timestamp: at(7) },
  ]));
  await service.refresh();
  const id = `claude:${rootId}`;
  assert.equal(service.get(id)?.lastRequestAt, at(1));
  assert.equal(service.get(id)?.lastCompletedAt, undefined);
  await appendFile(claude, lines([message('assistant', 'Finished', 8, 'end_turn')]));
  await service.refresh();
  assert.equal(service.get(id)?.lastCompletedAt, at(8));
  await appendFile(claude, lines([message('user', 'Continue', 9), message('assistant', 'Output limit', 10, 'max_tokens')]));
  await service.refresh();
  assert.equal(service.get(id)?.lastRequestAt, at(9));
  assert.equal(service.get(id)?.lastCompletedAt, at(10));
});

test('missing or invalid log timestamps never manufacture request and completion times', async t => {
  const { service, codex } = await fixture(t);
  const original = codexMessage('user', 'Real request', '2026-09-15T00:00:00.000Z');
  const createdAt = Date.parse(old) / 1000;
  original.payload.internal_chat_message_metadata_passthrough = { create_time: createdAt };
  await writeFile(codex, lines([row('session_meta', { id: rootId, timestamp: old }, old), original,
    codexMessage('user', 'Missing timestamp', 'invalid'), codexMessage('assistant', 'Missing completion time', '', 'final')]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.lastRequestAt, old);
  assert.equal(service.get(`codex:${rootId}`)?.lastCompletedAt, undefined);
});

test('native guardian permission assessors are excluded while user code-reviewer children remain visible',async(t)=>{
  const {service,codexHome,codex}=await fixture(t);
  await writeFile(codex,lines([row('session_meta',{id:rootId,cwd:'/work',thread_source:'guardian_review',source:{subagent:{other:'guardian'}},parent_thread_id:childId}),codexMessage('user','Internal permission assessment')]));
  await writeFile(join(codexHome,'sessions',`rollout-${childId}.jsonl`),lines([row('session_meta',{id:childId,cwd:'/work',thread_source:'subagent',source:{subagent:{thread_spawn:{parent_thread_id:rootId}}},agent_nickname:'code-reviewer'}),codexMessage('user','Review the user-facing changes')]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`),undefined);
  assert.equal(await service.detail(`codex:${rootId}`),undefined);
  assert.equal(service.get(`codex:${childId}`)?.agentName,'code-reviewer');
  assert.equal(service.list().length,1);
});

test('Claude subagents retain separate IDs and tool results are not mistaken for human prompts', async (t) => {
  const { service, claudeHome } = await fixture(t);
  const folder = join(claudeHome, 'projects', 'test', rootId, 'subagents');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'agent-a123.jsonl'), lines([
    { type: 'user', sessionId: rootId, agentId: 'a123', cwd: '/work/claude', timestamp: now(), uuid: 'u1', message: { role: 'user', content: 'Run the database migration tests' } },
    { type: 'assistant', sessionId: rootId, timestamp: now(), uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-4-6', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }], stop_reason: 'tool_use' } },
    { type: 'user', sessionId: rootId, timestamp: now(), uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'All tests passed.' }] } },
    { type: 'assistant', sessionId: rootId, timestamp: now(), uuid: 'a2', message: { role: 'assistant', content: [{ type: 'text', text: 'The migration is verified.' }], stop_reason: 'end_turn' } },
  ]));
  await service.refresh();
  const session = service.get('claude:a123')!;
  assert.equal(session.parentId, `claude:${rootId}`);
  assert.equal(session.resumable, false);
  assert.equal(session.model, 'claude-opus-4-6');
  assert.equal(session.status, 'completed');
  const detail = await service.detail('claude:a123');
  assert.deepEqual(detail?.messages.map((message) => message.role), ['user', 'tool', 'tool', 'assistant']);
  assert.equal(detail?.messages[2]?.toolName, 'result');
  assert.equal(detail?.messages[2]?.text, 'All tests passed.');
});

test('pagination crosses large UTF-8 records without duplicates, gaps, or loading all history', async (t) => {
  const { service, codex } = await fixture(t);
  const expected = Array.from({ length: 31 }, (_, i) => `${i} 메시지 ${i === 14 ? '한글'.repeat(100_000) : '내용'}`);
  await writeFile(codex, lines([row('session_meta', { id: rootId, timestamp: old, cwd: '/work' }, old), ...expected.map((value) => codexMessage('user', value, old))]));
  await service.refresh();
  const received: string[] = [];
  let before: number | undefined;
  let pages = 0;
  do {
    const detail = await service.detail(`codex:${rootId}`, before, 7);
    assert.ok(detail);
    received.unshift(...detail.messages.map((message) => message.text));
    if (before !== undefined && detail.nextBefore !== undefined) assert.ok(detail.nextBefore < before);
    before = detail.nextBefore;
    assert.ok(++pages < 10);
  } while (before !== undefined);
  assert.equal(received.length, expected.length);
  assert.deepEqual(received.map((value) => value.split(' ')[0]), expected.map((value) => value.split(' ')[0]));
  assert.ok(!received[14]!.includes('�'), 'UTF-8 must not break at chunk boundaries');
});

test('partial trailing writes and malformed lines recover, then rotation resets summary', async (t) => {
  const { service, codex } = await fixture(t);
  const partial = JSON.stringify(codexMessage('user', 'A partially written message'));
  await writeFile(codex, lines([row('session_meta', { id: rootId, timestamp: now() })]) + partial.slice(0, 50));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 0);
  await appendFile(codex, partial.slice(50) + '\n{malformed}\n' + lines([codexMessage('assistant', 'Recovered.', now(), 'final')]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 2);
  assert.equal((await service.detail(`codex:${rootId}`))?.messages.length, 2);
  await writeFile(codex, lines([row('session_meta', { id: rootId, timestamp: now() }), codexMessage('user', 'New rotated file')]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.messageCount, 1);
  assert.equal(service.get(`codex:${rootId}`)?.title, 'New rotated file');
  await rm(codex);
  await service.refresh();
  assert.equal(service.list().length, 0);
});

test('archiving does not falsely mark an unfinished task completed', async (t) => {
  const { service, codexHome } = await fixture(t);
  await mkdir(join(codexHome, 'archived_sessions'), { recursive: true });
  await writeFile(join(codexHome, 'archived_sessions', `${rootId}.jsonl`), lines([
    row('session_meta', { id: rootId, timestamp: now() }), row('event_msg', { type: 'task_started' }), codexMessage('user', 'Archived task'),
  ]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.status, 'error');
  assert.equal(service.get(`codex:${rootId}`)?.statusReason, 'Archived without a completed last task');
  await appendFile(join(codexHome, 'archived_sessions', `${rootId}.jsonl`), lines([row('event_msg', {type:'task_complete'})]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.status, 'completed');
});

test('giant metadata records cannot trap pagination on an empty page', async (t) => {
  const {service,codex}=await fixture(t);
  await writeFile(codex, lines([row('session_meta',{id:rootId,timestamp:old,cwd:'/work'},old),codexMessage('user','Before giant metadata',old)]));
  await appendFile(codex,'{"type":"world_state","payload":"');
  await appendFile(codex,'x'.repeat(40*1024*1024));
  await appendFile(codex,'"}\n'+lines([codexMessage('assistant','After giant metadata',now(),'final')]));
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.messageCount,2);
  const received:string[]=[];
  let before:number|undefined;
  let pages=0;
  do{
    const detail=await service.detail(`codex:${rootId}`,before,1);
    assert.ok(detail);
    received.unshift(...detail.messages.map(message=>message.text));
    if(before!==undefined&&detail.nextBefore!==undefined)assert.ok(detail.nextBefore<before,'every page must advance its cursor, including empty metadata pages');
    before=detail.nextBefore;
    assert.ok(++pages<8,'history must remain reachable behind an oversized record');
  }while(before!==undefined);
  assert.deepEqual(received,['Before giant metadata','After giant metadata']);
});

test('newer Claude turn logs take precedence over cached idle or busy registry states', async (t)=>{
  const {service,claude,claudeHome}=await fixture(t);
  await mkdir(join(claudeHome,'sessions'),{recursive:true});
  const timestamp=Date.now();
  await writeFile(join(claudeHome,'sessions',`${process.pid}.json`),JSON.stringify({pid:process.pid,sessionId:rootId,status:'idle',updatedAt:timestamp-1000}));
  await writeFile(claude,lines([{type:'user',sessionId:rootId,cwd:'/work',timestamp:new Date(timestamp).toISOString(),message:{role:'user',content:'A new live turn'}}]));
  await service.refresh();
  assert.equal(service.get(`claude:${rootId}`)?.status,'working','stale cached idle cannot authorize a concurrent writer');
  const second=new SessionService({codexHome:service.codexHome,claudeHome,inspectProcesses:async()=>({claude:new Map([[rootId,{status:'busy',updatedAt:timestamp-1000}]]),codex:new Set(),providerRunning:{claude:true,codex:false}})});
  await appendFile(claude,lines([{type:'assistant',sessionId:rootId,timestamp:new Date(timestamp+1).toISOString(),message:{role:'assistant',content:'Finished',stop_reason:'end_turn'}}]));
  await second.refresh();
  assert.equal(second.get(`claude:${rootId}`)?.status,'idle','a newer completed turn overrides an older busy registry');
});

test('exact open Codex rollout keeps a silent long-running turn live without reviving unrelated sessions', async (t)=>{
  const {codexHome,claudeHome,codex}=await fixture(t);
  const openFiles=`p123\nn${join(codexHome,'sessions','2026','09','14',`rollout-2026-09-14-${rootId}.jsonl`)}\nn/elsewhere/sessions/${childId}.jsonl\nn${join(codexHome,'auth.json')}\n`;
  const live=parseCodexOpenFiles(openFiles,codexHome);
  assert.deepEqual([...live],[rootId]);
  await writeFile(codex,lines([row('session_meta',{id:rootId,cwd:'/work',timestamp:old},old),codexMessage('user','A long silent turn',old)]));
  const service=new SessionService({codexHome,claudeHome,inspectProcesses:async()=>({claude:new Map(),codex:live,providerRunning:{claude:false,codex:true}})});
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.status,'working');
  assert.equal(service.get(`codex:${rootId}`)?.activeProcess,true);
});

test('instruction admission can refresh writer ownership without waiting for the display cache', async t => {
  const { codexHome, claudeHome, codex } = await fixture(t);
  await writeFile(codex, lines([
    row('session_meta', { id: rootId, cwd: '/work', timestamp: old }, old),
    codexMessage('assistant', 'Finished', old, 'final'),
  ]));
  let live = false;
  let probes = 0;
  const service = new SessionService({ codexHome, claudeHome, inspectProcesses: async () => {
    probes++;
    return { claude: new Map(), codex: new Set(live ? [rootId] : []), providerRunning: { claude: false, codex: live } };
  } });
  await service.refresh();
  assert.equal(service.get(`codex:${rootId}`)?.activeProcess, false);
  live = true;
  await service.refresh();
  assert.equal(probes, 1);
  await service.refresh(true);
  assert.equal(probes, 2);
  assert.equal(service.get(`codex:${rootId}`)?.status, 'idle');
  assert.equal(service.get(`codex:${rootId}`)?.activeProcess, true);
});

test('chat extraction omits injected setup and internal reasoning but retains visible commentary', () => {
  assert.deepEqual(parseMessages('codex', codexMessage('user', '# AGENTS.md instructions\nInternal setup')), []);
  assert.deepEqual(parseMessages('codex', row('response_item', { type: 'reasoning', summary: [{ text: 'Private reasoning' }] })), []);
  assert.deepEqual(parseMessages('claude', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Private reasoning' }] } }), []);
  assert.equal(parseMessages('codex', codexMessage('assistant', 'Running the checks now.', now(), 'commentary'))[0]?.text, 'Running the checks now.');
});

test('a verified Claude process can remain idle despite an old transcript, while dead PID records cannot revive history', async (t) => {
  const { service, claude, claudeHome } = await fixture(t);
  await mkdir(join(claudeHome, 'sessions'), { recursive: true });
  await writeFile(join(claudeHome, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: rootId, status: 'idle', updatedAt: Date.now() }));
  // Sidecar peer keys must never be parsed as session registry metadata.
  await writeFile(join(claudeHome, 'sessions', '123.fake.key'), JSON.stringify({ pid: process.pid, sessionId: childId, status: 'busy' }));
  await writeFile(claude, lines([{ type: 'user', sessionId: rootId, cwd: '/old/claude', timestamp: old, message: { role: 'user', content: 'An old prompt' } }]));
  await writeFile(join(claudeHome, 'projects', 'test', `${childId}.jsonl`), lines([{ type: 'user', sessionId: childId, timestamp: old, message: { role: 'user', content: 'Another old prompt' } }]));
  await writeFile(join(claudeHome, 'sessions', '2147483647.json'), JSON.stringify({ pid: 2147483647, sessionId: childId, status: 'busy', updatedAt: Date.now() }));
  await service.refresh();
  assert.equal(service.get(`claude:${rootId}`)?.status, 'idle');
  assert.equal(service.get(`claude:${rootId}`)?.activeProcess, true);
  assert.equal(service.get(`claude:${childId}`)?.status, 'error');
  assert.equal(service.get(`claude:${childId}`)?.activeProcess, false);
});
