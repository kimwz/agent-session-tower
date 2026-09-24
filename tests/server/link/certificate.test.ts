import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { certificatePin, createLinkCertificate } from '../../../server/link/certificate.js';

const run = promisify(execFile);

test('a link certificate carries its own key, never expires, and is a well-formed X.509 certificate', async t => {
  const { key, cert } = createLinkCertificate('agent-session-tower test');
  const certificate = new X509Certificate(cert);
  assert.equal(certificate.subject, 'CN=agent-session-tower test');
  assert.ok(certificate.verify(certificate.publicKey), 'self-signed with its own key');
  assert.ok(certificate.checkPrivateKey(createPrivateKey(key)));
  assert.equal(new Date(certificate.validTo).getUTCFullYear(), 9999);
  assert.ok(new Date(certificate.validFrom).getTime() <= Date.now());
  const spki = createPublicKey(cert).export({ type: 'spki', format: 'der' });
  assert.equal(certificatePin(cert), createHash('sha256').update(spki).digest('base64url'));
  assert.notEqual(certificatePin(createLinkCertificate('another').cert), certificatePin(cert), 'every identity has its own key');

  const openssl = await run('openssl', ['version']).then(() => true, () => false);
  if (!openssl) { t.diagnostic('openssl is not installed; strict parsing was not checked'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'tower-cert-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'cert.pem'), cert);
  const { stdout } = await run('openssl', ['verify', '-x509_strict', '-CAfile', join(dir, 'cert.pem'), join(dir, 'cert.pem')]);
  assert.match(stdout, /: OK/);
});
