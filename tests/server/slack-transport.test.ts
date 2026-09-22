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
