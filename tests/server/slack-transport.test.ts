import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { SlackClient } from '../../server/slack/client.js';
import { SlackSocket } from '../../server/slack/socket.js';

const ok = (value: object) => new Response(JSON.stringify({ ok: true, ...value }));
test('Slack thread exhausts pages and rejects incomplete context', async () => {
  const requests: URLSearchParams[] = [];
  const client = new SlackClient('secret', { fetch: (async (_url, init) => {
    requests.push(init!.body as URLSearchParams);
    return requests.length === 1 ? ok({ messages: [{ts:'1',text:'root',user:'U'}], response_metadata:{next_cursor:'next'} }) : ok({ messages:[{ts:'2',text:'reply',bot_id:'B'}] });
  }) as typeof fetch });
  assert.deepEqual(await client.thread('C','1'), [{ts:'1',text:'root',user:'U'}, {ts:'2',text:'reply',user:'B'}]);
  assert.equal(requests[1].get('cursor'), 'next');
  const incomplete = new SlackClient('secret', {fetch:(async () => ok({messages:[],has_more:true})) as typeof fetch});
  await assert.rejects(incomplete.thread('C','1'), /incomplete_thread/);
});
test('Slack thread includes attachment content posted by integrations', async () => {
  const client = new SlackClient('secret', { fetch: (async () => ok({ messages: [
    { ts: '1', text: '', bot_id: 'B', attachments: [{ pretext: 'Pull request opened by <https://github.com/d|d>', title: '#627 chore: upgrade', title_link: 'https://github.com/o/r/pull/627', text: 'body', fields: [{ title: 'Reviewers', value: 'karl' }] }] },
    { ts: '2', bot_id: 'B', attachments: [{ fallback: 'only fallback' }] },
    { ts: '3', text: 'see this', user: 'U', attachments: [{ title: 'Link', text: 'unfurl' }] },
    { ts: '4', user: 'U', files: [{}] },
  ] })) as typeof fetch });
  assert.deepEqual(await client.thread('C', '1'), [
    { ts: '1', user: 'B', text: 'Pull request opened by <https://github.com/d|d>\n<https://github.com/o/r/pull/627|#627 chore: upgrade>\nbody\nReviewers: karl' },
    { ts: '2', user: 'B', text: 'only fallback' },
    { ts: '3', user: 'U', text: 'see this\n\nLink\nunfurl' },
    { ts: '4', user: 'U', text: '' },
  ]);
});
test('Slack reads retry rate limits; replies never retry and escape mentions', async () => {
  let calls = 0;
  const delays: number[] = [];
  const client = new SlackClient('secret', {fetch:(async () => ++calls === 1 ? new Response('',{status:429,headers:{'retry-after':'2'}}) : ok({team_id:'T',user_id:'U'})) as typeof fetch,sleep:async(ms)=>{delays.push(ms);}});
  assert.equal((await client.auth()).userId,'U');
  assert.deepEqual(delays,[2000]);
  let sent: URLSearchParams | undefined;
  const writer = new SlackClient('secret', {fetch:(async (_url,init) => {sent=init!.body as URLSearchParams;return new Response('',{status:429});}) as typeof fetch});
  await assert.rejects(writer.reply('C','1','hello <@U> & <!channel>'), /ratelimited/);
  assert.equal(sent!.get('text'),'hello &lt;@U&gt; &amp; &lt;!channel&gt;');
  assert.equal(sent!.get('reply_broadcast'),'false');
  await assert.rejects(writer.reply('C','1','<@U2> <@U3> <!channel> <@U2|x>', ['U2']), /ratelimited/);
  assert.equal(sent!.get('text'),'<@U2> &lt;@U3&gt; &lt;!channel&gt; &lt;@U2|x&gt;');
  await assert.rejects(writer.reply('C','1','확인\nhttps://github.com/o/r/pull/1#issuecomment-2 (see https://x.io/a?b=1&c=<2>). https://x.io/wiki/A_(b))'), /ratelimited/);
  assert.equal(sent!.get('text'),'확인\n<https://github.com/o/r/pull/1#issuecomment-2> (see <https://x.io/a?b=1&amp;c=>&lt;2&gt;). <https://x.io/wiki/A_(b)>)');
  assert.equal(sent!.get('blocks'), null);
  await assert.rejects(writer.reply('C','1','<@U2> <@U3> 확인 https://x.io/a. 끝', ['U2'], "Sent by karl's agent"), /ratelimited/);
  assert.equal(sent!.get('text'),'<@U2> &lt;@U3&gt; 확인 <https://x.io/a>. 끝');
  assert.deepEqual(JSON.parse(sent!.get('blocks')!), [
    { type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U2' }, { type: 'text', text: ' ' }, { type: 'text', text: '<@U3>' }, { type: 'text', text: ' 확인 ' }, { type: 'link', url: 'https://x.io/a' }, { type: 'text', text: '.' }, { type: 'text', text: ' 끝' }] }] },
    { type: 'context', elements: [{ type: 'plain_text', text: "Sent by karl's agent", emoji: false }] },
  ]);
});
test('Slack reactions treat existing and already removed reactions as done', async () => {
  const calls: string[] = [];
  const client = new SlackClient('secret', {fetch:(async (url: string, init) => { calls.push(`${url.split('/').pop()}:${(init!.body as URLSearchParams).get('name')}`); return new Response(JSON.stringify({ok:false,error:url.endsWith('add')?'already_reacted':'no_reaction'})); }) as typeof fetch});
  await client.react('C','1','eyes','add'); await client.react('C','1','eyes','remove');
  assert.deepEqual(calls,['reactions.add:eyes','reactions.remove:eyes']);
  const denied = new SlackClient('secret', {fetch:(async () => new Response(JSON.stringify({ok:false,error:'missing_scope'}))) as typeof fetch});
  await assert.rejects(denied.react('C','1','eyes','add'), /missing_scope/);
});
test('Slack errors never expose token-bearing server or network messages', async () => {
  for (const fetcher of [async()=>{throw new Error('secret');}, async()=>new Response(JSON.stringify({ok:false,error:'secret'}))]) {
    await assert.rejects(new SlackClient('secret',{fetch:fetcher as typeof fetch}).auth(), error => error instanceof Error && !error.message.includes('secret'));
  }
});
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: string[] = [];
  terminate() { this.emit('close'); }
  send(text: string) { this.sent.push(text); }
  ping() { this.emit('pong'); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test('Socket ACK waits for durable ingestion; stop prevents reconnect', async () => {
  const socket = new FakeSocket();
  let save!:()=>void;
  let opens=0;
  const client = new SlackSocket({appToken:'secret',openSocketUrl:async()=>{opens++;return 'wss://example.slack.com';},createSocket:()=>socket as unknown as WebSocket,onEvent:()=>new Promise<void>(r=>{save=r;}),reconnectMs:1});
  client.start(); await tick(); socket.emit('open');
  socket.emit('message',Buffer.from(JSON.stringify({type:'events_api',envelope_id:'E',payload:{event_id:'X'}})));
  assert.deepEqual(socket.sent,[]); save(); await tick();
  assert.deepEqual(socket.sent,[JSON.stringify({envelope_id:'E'})]);
  client.stop(); await new Promise(r=>setTimeout(r,10)); assert.equal(opens,1);
});
test('Socket failed ingestion is never acknowledged', async () => {
  const socket = new FakeSocket();
  const client = new SlackSocket({appToken:'secret',openSocketUrl:async()=> 'wss://example.slack.com',createSocket:()=>socket as unknown as WebSocket,onEvent:async()=>{throw new Error('secret');},reconnectMs:100});
  client.start(); await tick(); socket.emit('message',Buffer.from(JSON.stringify({type:'events_api',envelope_id:'E',payload:{}}))); await tick();
  assert.deepEqual(socket.sent,[]);client.stop();
});
