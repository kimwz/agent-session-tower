import test from 'node:test';
import assert from 'node:assert/strict';
import type { NetworkInterfaceInfo } from 'node:os';
import { networkAccess } from '../../../server/http/remote-access.js';

function entry(address: string, internal = false, family = 'IPv4'): NetworkInterfaceInfo {
  return { address, internal, family, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24`, scopeid: 0 } as NetworkInterfaceInfo;
}

const interfaces = {
  lo0: [entry('127.0.0.1', true), entry('::1', true, 'IPv6')],
  en0: [entry('203.0.113.10'), entry('2001:db8::1', false, 'IPv6')],
  en1: [entry('192.168.0.12'), entry('203.0.113.10')],
};

test('wildcard IPv4 bind requires authentication and permits only the current IPv4 interface origins', () => {
  const access = networkAccess('0.0.0.0', 8000, interfaces);
  assert.equal(access.remote, true);
  assert.equal(access.browserUrl, 'http://localhost:8000');
  assert.deepEqual([...access.origins], ['http://203.0.113.10:8000', 'http://192.168.0.12:8000']);
  assert.equal(access.origins.has('http://0.0.0.0:8000'), false);
});

test('explicit bind trusts only that address and opens a reachable URL', () => {
  const access = networkAccess('203.0.113.10', 8000, interfaces);
  assert.equal(access.remote, true);
  assert.deepEqual([...access.origins], ['http://203.0.113.10:8000']);
  assert.equal(access.browserUrl, 'http://203.0.113.10:8000');
  assert.equal(networkAccess('127.0.0.1', 8000, interfaces).remote, false);
  assert.equal(networkAccess('127.0.0.2', 8000, interfaces).remote, false);
  assert.equal(networkAccess('127.0.0.2', 8000, interfaces).browserUrl, 'http://127.0.0.2:8000');
  assert.deepEqual([...networkAccess('203.0.113.10', 80, interfaces).origins], ['http://203.0.113.10']);
  assert.throws(() => networkAccess('example.com', 8000, interfaces), /IPv4/);
  assert.throws(() => networkAccess('::', 8000, interfaces), /IPv4/);
});

test('public URLs from a proxy or tunnel make a loopback bind remote and trust only their origins', () => {
  const access = networkAccess('127.0.0.1', 8000, interfaces, ['https://tower.example.com', 'https://tower.example.com/']);
  assert.equal(access.remote, true);
  assert.equal(access.browserUrl, 'http://localhost:8000');
  assert.deepEqual([...access.origins], ['https://tower.example.com']);
  assert.deepEqual(access.urls, ['https://tower.example.com']);
  assert.deepEqual([...networkAccess('0.0.0.0', 8000, interfaces, ['https://tower.example.com:8443']).origins],
    ['http://203.0.113.10:8000', 'http://192.168.0.12:8000', 'https://tower.example.com:8443']);
  for (const url of ['tower.example.com', 'https://tower.example.com/app', 'https://tower.example.com/?a=1', 'https://user@tower.example.com', 'ftp://tower.example.com']) {
    assert.throws(() => networkAccess('127.0.0.1', 8000, interfaces, [url]), /--public-url/);
  }
});
