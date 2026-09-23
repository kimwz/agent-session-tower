import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { startSlackMcp } from '../../../server/slack/mcp-bridge.js';

test('bound Slack MCP exposes only conversation tools and preserves request IDs', async () => {
  const calls: unknown[] = []; let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } });
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'slack_reply', arguments: { requestKey: 'reply1', text: 'Done' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cancel', arguments: { id: 'other' } } },
  ];
  await startSlackMcp('/tmp/fixture', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', Readable.from(frames.map(frame => JSON.stringify(frame) + '\n')), output, async (name, args) => { calls.push({name,args}); return {status:'sent'}; });
  const replies = text.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(replies.map(reply => reply.id), [1,2,3,4]);
  assert.equal(replies[0].result.protocolVersion, '2025-03-26');
  assert.deepEqual(replies[1].result.tools.map((tool: {name:string}) => tool.name), ['tower_auto_prompt','tower_task_status','tower_task_complete','slack_send','slack_react','slack_thread','slack_reply']);
  assert.deepEqual(calls, [{ name:'slack_reply', args:{ requestKey:'reply1',text:'Done' } }]);
  assert.equal(replies[3].result.isError,true);
});

test('MCP reports uncertain tool failures without automatic retry', async () => {
  let calls=0, text='';
  const frame={jsonrpc:'2.0',id:'send',method:'tools/call',params:{name:'slack_reply',arguments:{requestKey:'same',text:'reply'}}};
  await startSlackMcp('/tmp/fixture','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',Readable.from([JSON.stringify(frame)+'\n']),new Writable({write(chunk,_enc,done){text+=chunk;done();}}),async()=>{calls++;throw Error('Delivery uncertain');});
  assert.equal(calls,1);assert.equal(JSON.parse(text).result.isError,true);assert.match(text,/Delivery uncertain/);
});

test('a Slack tool server started without a capability serves only a worker from before capabilities', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { startLegacyRunner } = await import('../runs/fixtures/legacy-runner.ts');
  const directory = await mkdtemp(join(tmpdir(), 'tower-slack-legacy-'));
  const stateDir = join(directory, 'state');
  const legacy = await startLegacyRunner(stateDir, { runs: [], sessions: [], nativeIds: {}, settled: [], autoPrompts: [] });
  t.after(async () => { await legacy.close(); await rm(directory, { recursive: true, force: true }); await rm(legacy.directory, { recursive: true, force: true }); });
  const previous = process.env.TOWER_MCP_CAPABILITY;
  delete process.env.TOWER_MCP_CAPABILITY;
  let text = '';
  try {
    const frame = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_thread', arguments: {} } };
    await startSlackMcp(stateDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', Readable.from([JSON.stringify(frame) + '\n']), new Writable({ write(chunk, _encoding, done) { text += chunk; done(); } }));
  } finally { if (previous !== undefined) process.env.TOWER_MCP_CAPABILITY = previous; }
  assert.equal(JSON.parse(text).result.isError, undefined);
  assert.deepEqual(legacy.methods, ['snapshot', 'slackTool']);
});
