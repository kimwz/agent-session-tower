import test from 'node:test';
import assert from 'node:assert/strict';
import { socketOwner, tableEndpoints } from '../../../server/http/auth.js';

const header = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const row = (local: string, remote: string, state: string, uid: number, inode: number) => `   0: ${local} ${remote} ${state} 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode} 1 0000000000000000 20 4 30 10 -1`;

test('on Linux, a loopback connection is known by the owner of exactly that connection in the kernel’s socket table', () => {
  const browser = { address: '127.0.0.1', port: 0xC738 }, server = { address: '127.0.0.1', port: 8000 };
  const table = [header,
    row('0100007F:1F40', '00000000:0000', '0A', 0, 11),                  // this server listening
    row('0100007F:C738', '0100007F:1F40', '01', 1000, 12),                // the browser's end
    row('0100007F:1F40', '0100007F:C738', '01', 0, 13)].join('\n');       // this server's end
  assert.equal(socketOwner(table, browser, server), 1000);
  // Another account cannot pass for root with a connection waiting to close (the kernel shows those as uid 0 and no inode).
  const waiting = [header, row('0200007F:C738', '0100007F:1F40', '06', 0, 0), row('0100007F:C738', '0100007F:1F40', '01', 1001, 14)].join('\n');
  assert.equal(socketOwner(waiting, browser, server), 1001);
  // Nor with the owner's connection from another loopback address and the same port.
  const lookalike = [header, row('0200007F:C738', '0100007F:1F40', '01', 1000, 15), row('0100007F:C738', '0100007F:1F40', '01', 1001, 16)].join('\n');
  assert.equal(socketOwner(lookalike, browser, server), 1001);
  assert.equal(socketOwner([header, row('0100007F:C738', '0100007F:1F40', '01', 1000, 17), row('0100007F:C738', '0100007F:1F40', '01', 1001, 18)].join('\n'), browser, server), undefined,
    'two rows for one connection are not trusted');
  assert.equal(socketOwner(table, { address: '127.0.0.1', port: 0xC73A }, server), undefined, 'a connection it cannot find is not taken as local');
});

test('addresses are written as the kernel writes them, IPv6 and mapped IPv4 included', () => {
  assert.deepEqual(tableEndpoints('127.0.0.1', 8000), ['0100007F:1F40', '7F000001:1F40']);
  assert.equal(tableEndpoints('::1', 8000)[0], '00000000000000000000000001000000:1F40');
  assert.equal(tableEndpoints('::ffff:127.0.0.1', 8000)[0], '0000000000000000FFFF00000100007F:1F40');
  const six = [header, row('0000000000000000FFFF00000100007F:C739', '0000000000000000FFFF00000100007F:1F40', '01', 33, 19)].join('\n');
  assert.equal(socketOwner(six, { address: '::ffff:127.0.0.1', port: 0xC739 }, { address: '::ffff:127.0.0.1', port: 8000 }), 33);
});
