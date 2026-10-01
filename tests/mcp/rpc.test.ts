import test from 'node:test';
import assert from 'node:assert/strict';
import { answerRpc, type ToolBridge } from '../../server/mcp/stdio.js';

const bridge = (overrides: Partial<ToolBridge> = {}): ToolBridge => ({ name: 'tools', listTools: async () => [{ name: 'echo' }], callTool: async (_name, args) => args, ...overrides });

test('one JSON-RPC message is answered the same for stdio and HTTP: requests, notifications, responses and mistakes', async () => {
  assert.deepEqual(await answerRpc(bridge(), { jsonrpc: '2.0', id: 1, method: 'ping' }), { jsonrpc: '2.0', id: 1, result: {} });
  assert.deepEqual((await answerRpc(bridge(), { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } }))?.result, { content: [{ type: 'text', text: '{"a":1}' }] });
  assert.equal(await answerRpc(bridge(), { jsonrpc: '2.0', method: 'notifications/initialized' }), undefined, 'a notification');
  assert.equal(await answerRpc(bridge(), { jsonrpc: '2.0', id: 3, result: {} }), undefined, 'a response');
  assert.equal((await answerRpc(bridge(), { id: 4, method: 'ping' }))?.error?.code, -32600, 'not JSON-RPC 2.0');
  assert.equal((await answerRpc(bridge(), { jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }))?.error?.message, 'Invalid request ID');
  assert.equal((await answerRpc(bridge(), { jsonrpc: '2.0', id: 5, method: 'nope' }))?.error?.code, -32601);
  assert.equal((await answerRpc(bridge({ listTools: async () => { throw new Error('down'); } }), { jsonrpc: '2.0', id: 6, method: 'tools/list' }))?.error?.code, -32603);
  assert.deepEqual((await answerRpc(bridge(), { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'echo', arguments: [1] } }))?.result, { isError: true, content: [{ type: 'text', text: 'Tool arguments must be an object.' }] });
});
