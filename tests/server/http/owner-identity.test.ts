import test from 'node:test';
import assert from 'node:assert/strict';
import { socketOwner } from '../../../server/http/auth.js';

test('on Linux, a loopback connection is known by its owner in the kernel’s socket tables', () => {
  // A browser (uid 1000) connected from port 51000 to this server's port 8000, and this server's own end of it (uid 0).
  const tcp = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:C738 0100007F:1F40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:1F40 0100007F:C738 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 20 4 30 10 -1`;
  const tcp6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:C739 00000000000000000000000001000000:1F40 01 00000000:00000000 00:00000000 00000000   33        0 4 1 0000000000000000 20 4 30 10 -1`;
  assert.equal(socketOwner([tcp, tcp6], 0xC738, 8000), 1000, 'the other end’s owner, not this server’s own end');
  assert.equal(socketOwner([tcp, tcp6], 0xC739, 8000), 33, 'IPv6 loopback too');
  assert.equal(socketOwner([tcp, tcp6], 0xC73A, 8000), undefined, 'a connection it cannot find is not taken as local');
});
