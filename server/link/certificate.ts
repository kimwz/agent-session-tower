import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';

/*
 * A link identity is its public key. TLS needs that key inside a certificate, so Tower writes the smallest
 * self-signed X.509 certificate that carries it. Peers never trust the certificate itself: they compare the
 * key's SHA-256 with the one they pinned, and TLS 1.3 proves the private key is held.
 */
const length = (n: number) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), length(body.length), body]); };
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
function oid(dotted: string): Buffer {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * first + second];
  for (const value of rest) {
    const chunk: number[] = [];
    let remaining = value;
    do { chunk.unshift(remaining & 0x7f); remaining >>= 7; } while (remaining);
    bytes.push(...chunk.map((byte, index) => index < chunk.length - 1 ? byte | 0x80 : byte));
  }
  return tlv(0x06, Buffer.from(bytes));
}
/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. 99991231235959Z means no expiry. */
function time(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`)) : tlv(0x18, Buffer.from(`${digits}Z`));
}
const name = (commonName: string) => sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(commonName)))));

export interface LinkCertificate { key: string; cert: string }

export function createLinkCertificate(commonName = 'agent-session-tower', now = new Date()): LinkCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, cert: certificateFor(privateKey, publicKey, commonName, now) };
}

function certificateFor(privateKey: KeyObject, publicKey: KeyObject, commonName: string, now: Date): string {
  const algorithm = sequence(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(16);
  // Positive and minimally encoded, as DER requires.
  serial[0] = (serial[0] & 0x7f) | 0x40;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    algorithm,
    name(commonName),
    sequence(time(new Date(now.getTime() - 60_000)), time(new Date(Date.UTC(9999, 11, 31, 23, 59, 59)))),
    name(commonName),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** The identity peers pin: SHA-256 of the certificate's public key, base64url. */
export function certificatePin(certificate: X509Certificate | string): string {
  const parsed = typeof certificate === 'string' ? new X509Certificate(certificate) : certificate;
  return createHash('sha256').update(parsed.publicKey.export({ type: 'spki', format: 'der' })).digest('base64url');
}
