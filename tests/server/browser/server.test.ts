import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import { startBrowserMcp, type BrowserServerHooks, type BrowserServerOptions } from '../../../server/browser/server.js';

type Frame = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: any; result?: any; error?: any };
const TOOLS = [{ name: 'browser_navigate', inputSchema: {} }, { name: 'browser_close', inputSchema: {} }, { name: 'browser_run_code_unsafe', inputSchema: {} }];

/** A stand-in for Playwright's MCP server: answers like it, records what reached it, asks the client for roots once. */
function fakePlaywright() {
  const seen: Frame[] = [];
  let connections = 0;
  const createConnection = (async () => {
    connections++;
    let transport: { send(frame: Frame): Promise<void>; onmessage?: (frame: Frame) => void };
    return {
      async connect(t: typeof transport) {
        transport = t;
        t.onmessage = frame => {
          seen.push(frame);
          if (frame.method === 'initialize') void transport.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} } } });
          else if (frame.method === 'tools/list') void transport.send({ jsonrpc: '2.0', id: frame.id, result: { tools: TOOLS } });
          else if (frame.method === 'tools/call') {
            void transport.send({ jsonrpc: '2.0', id: 'roots-1', method: 'roots/list' });
            void transport.send({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: `called ${frame.params.name} ${JSON.stringify(frame.params.arguments)}` }] } });
          }
        };
      },
      async close() {},
    };
  }) as unknown as NonNullable<BrowserServerHooks['createConnection']>;
  return { seen, createConnection, connections: () => connections };
}

async function serve(t: TestContext, options: Partial<BrowserServerOptions> = {}, extra: BrowserServerHooks = {}) {
  const stateDir = options.stateDir ?? await mkdtemp(join(tmpdir(), 'tower-browser-server-'));
  if (!options.stateDir) t.after(() => rm(stateDir, { recursive: true, force: true }));
  const input = new PassThrough(), output = new PassThrough();
  const signals = new EventEmitter();
  const playwright = fakePlaywright();
  const served = startBrowserMcp({ tier: 'general', stateDir, savedLogins: true, outsideContent: false, ...options }, input, output,
    { createConnection: playwright.createConnection, signals: signals as never, exit: () => {}, ready: Promise.resolve(), ...extra });
  const frames: Frame[] = [];
  let buffer = '';
  output.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { frames.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
  const reply = async (id: string | number) => { for (;;) { const frame = frames.find(f => f.id === id && !f.method); if (frame) return frame; await new Promise(resolve => setTimeout(resolve, 5)); } };
  const send = (frame: Omit<Frame, 'jsonrpc'>) => input.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  const init = async () => { send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} }, clientInfo: { name: 'client', version: '1' } } }); return reply(1); };
  return { stateDir, input, frames, reply, send, init, served, signals, playwright };
}

test('the server answers initialize with its instructions and lists its tools without loading Playwright once the list is known', async t => {
  const first = await serve(t, { strong: 'aside' });
  const init = await first.init();
  assert.match(init.result.instructions, /outside sites/);
  assert.match(init.result.instructions, /browser_strong/);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(first.playwright.connections(), 0, 'nothing loaded for initialize');
  first.send({ id: 2, method: 'tools/list' });
  assert.deepEqual((await first.reply(2)).result.tools.map((tool: { name: string }) => tool.name), TOOLS.map(tool => tool.name));
  assert.equal(first.playwright.connections(), 1, 'the first list ever asks Playwright');
  assert.deepEqual(first.playwright.seen[0].params.clientInfo, { name: 'client', version: '1' }, 'with the client\'s own initialize');
  first.input.end();
  await first.served;
  assert.ok((await readdir(join(first.stateDir, 'browser'))).some(name => /^tools-.+\.json$/.test(name)));
  const second = await serve(t, { stateDir: first.stateDir });
  await second.init();
  second.send({ id: 2, method: 'tools/list' });
  assert.equal((await second.reply(2)).result.tools.length, TOOLS.length);
  assert.equal(second.playwright.connections(), 0, 'kept per Playwright MCP version');
  second.input.end();
  await second.served;
});

test('tool calls reach Playwright in order, and its questions to the client are answered through the same stream', async t => {
  const s = await serve(t);
  await s.init();
  s.send({ id: 'c1', method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } } });
  const roots = await (async () => { for (;;) { const frame = s.frames.find(f => f.method === 'roots/list'); if (frame) return frame; await new Promise(resolve => setTimeout(resolve, 5)); } })();
  s.send({ id: roots.id, result: { roots: [] } });
  assert.match((await s.reply('c1')).result.content[0].text, /called browser_navigate/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(s.playwright.seen.map(frame => frame.method ?? 'answer'), ['initialize', 'notifications/initialized', 'tools/call', 'answer']);
  s.input.end();
  await s.served;
});

test('browser_close is Tower\'s own and never reaches Playwright', async t => {
  const s = await serve(t);
  await s.init();
  s.send({ id: 3, method: 'tools/call', params: { name: 'browser_close', arguments: {} } });
  assert.match((await s.reply(3)).result.content[0].text, /next browser tool call starts a new one/);
  assert.equal(s.playwright.connections(), 0);
  s.input.end();
  await s.served;
});

test('where outside content is, the tool that runs code outside the browser is neither listed nor run', async t => {
  const s = await serve(t, { outsideContent: true, savedLogins: false });
  const init = await s.init();
  assert.match(init.result.instructions, /localhost\) are blocked here/);
  s.send({ id: 2, method: 'tools/list' });
  assert.deepEqual((await s.reply(2)).result.tools.map((tool: { name: string }) => tool.name), ['browser_navigate', 'browser_close']);
  s.send({ id: 3, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: { code: 'fetch("http://127.0.0.1:8000")' } } });
  const refused = await s.reply(3);
  assert.equal(refused.result.isError, true);
  assert.equal(s.playwright.seen.some(frame => frame.method === 'tools/call'), false);
  s.input.end();
  await s.served;
});

test('a character split between two chunks arrives whole, bad JSON gets an error, and the signal handlers go with the server', async t => {
  const s = await serve(t);
  await s.init();
  assert.equal(s.signals.listenerCount('SIGTERM'), 1);
  const line = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 'k', method: 'tools/call', params: { name: 'browser_navigate', arguments: { text: '한글' } } }) + '\n');
  const cut = line.indexOf(Buffer.from('한')) + 1;
  s.input.write(line.subarray(0, cut));
  await new Promise(resolve => setTimeout(resolve, 10));
  s.input.write(line.subarray(cut));
  assert.match((await s.reply('k')).result.content[0].text, /"text":"한글"/);
  s.input.write('not json\n');
  assert.equal((await s.reply(null as never)).error.code, -32700);
  s.input.end();
  await s.served;
  assert.deepEqual(['SIGTERM', 'SIGINT', 'SIGHUP'].map(signal => s.signals.listenerCount(signal)), [0, 0, 0]);
});

test('Playwright gets the turn\'s browser from Tower: a call starts it, its logins are saved after the call, and browser_close closes it', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'tower-browser-wiring-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const closed: string[] = [];
  const sid = { name: 'sid', value: '1', domain: 'example.com', path: '/', expires: -1, httpOnly: false, secure: true, sameSite: 'Lax' };
  const context = Object.assign(new EventEmitter(), { cookies: async () => [sid], pages: () => [], close: async () => {} });
  const hooks: BrowserServerHooks = {
    startBrowser: async () => ({ browser: { close: async () => { closed.push('browser'); context.emit('close'); } } as never }),
    newContext: async () => context as never,
    findBrowserPid: async () => undefined,
    createConnection: (async (_config: unknown, getContext: () => Promise<unknown>) => ({
      async connect(transport: { send(frame: Frame): Promise<void>; onmessage?: (frame: Frame) => void }) {
        transport.onmessage = frame => {
          if (frame.method === 'initialize') void transport.send({ jsonrpc: '2.0', id: frame.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
          if (frame.method === 'tools/call') void getContext().then(() => transport.send({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: 'navigated' }] } }));
        };
      },
      async close() {},
    })) as never,
  };
  const s = await serve(t, { stateDir }, hooks);
  await s.init();
  s.send({ id: 'nav', method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.com' } } });
  await s.reply('nav');
  const { readState } = await import('../../../server/browser/logins.js');
  for (let i = 0; i < 100 && !(await readState(stateDir)).cookies.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual((await readState(stateDir)).cookies.map(c => c.name), ['sid'], 'saved right after the call');
  s.send({ id: 'close', method: 'tools/call', params: { name: 'browser_close', arguments: {} } });
  await s.reply('close');
  assert.deepEqual(closed, ['browser']);
  s.input.end();
  await s.served;
});
