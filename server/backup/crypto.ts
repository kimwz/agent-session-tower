import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, type ScryptOptions } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BACKUP_FORMAT, MAX_BACKUP_FILE_BYTES, MIN_BACKUP_PASSPHRASE } from '../../shared/backup.js';

/** What a backup file says about itself; all of it is authenticated with the contents. */
export interface BackupHeader {
  format: typeof BACKUP_FORMAT;
  version: 1;
  createdAt: string;
  towerVersion: string;
  from: string;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
}
interface BackupEnvelope extends BackupHeader { tag: string; data: string }

const KDF = { N: 65_536, r: 8, p: 1 };
/** The payload may be many times smaller than what it expands to; this bounds a hostile file. */
const MAX_PLAIN_BYTES = 200 * 1024 * 1024;

export class BackupError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

export function checkPassphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length < MIN_BACKUP_PASSPHRASE || value.length > 1024) throw new BackupError(`암호는 ${MIN_BACKUP_PASSPHRASE}자 이상이어야 합니다.`);
  return value;
}

function deriveKey(passphrase: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  const options: ScryptOptions = { ...params, maxmem: 256 * 1024 * 1024 };
  return new Promise((resolve, reject) => scryptCallback(passphrase, salt, 32, options, (error, key) => error ? reject(error) : resolve(key)));
}

/** The header in a fixed order, as the cipher authenticates it. */
function additionalData(header: BackupHeader): Buffer {
  const { format, version, createdAt, towerVersion, from, kdf, cipher, iv } = header;
  return Buffer.from(JSON.stringify([format, version, createdAt, towerVersion, from, [kdf.name, kdf.N, kdf.r, kdf.p, kdf.salt], cipher, iv]));
}

export async function encryptBackup(payload: unknown, passphrase: string, meta: { towerVersion: string; from: string; createdAt?: string }): Promise<string> {
  const salt = randomBytes(16), iv = randomBytes(12);
  const header: BackupHeader = { format: BACKUP_FORMAT, version: 1, createdAt: meta.createdAt ?? new Date().toISOString(), towerVersion: meta.towerVersion, from: meta.from,
    kdf: { name: 'scrypt', ...KDF, salt: salt.toString('base64') }, cipher: 'aes-256-gcm', iv: iv.toString('base64') };
  const key = await deriveKey(checkPassphrase(passphrase), salt, KDF);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(additionalData(header));
  const data = Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  const envelope: BackupEnvelope = { ...header, tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  const text = JSON.stringify(envelope);
  if (Buffer.byteLength(text) > MAX_BACKUP_FILE_BYTES) throw new BackupError('백업이 40MB를 넘습니다. 큰 스킬 파일을 정리한 뒤 다시 시도하세요.', 413);
  return text;
}

const base64 = (value: unknown, bytes?: number) => typeof value === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && (bytes === undefined || Buffer.from(value, 'base64').length === bytes);
const whole = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** The header of a backup file, checked, without decrypting it. */
export function readBackupHeader(text: string): BackupEnvelope {
  if (Buffer.byteLength(text) > MAX_BACKUP_FILE_BYTES) throw new BackupError('백업 파일이 너무 큽니다.', 413);
  let value: Partial<BackupEnvelope>;
  try { value = JSON.parse(text) as Partial<BackupEnvelope>; } catch { throw new BackupError('Tower 백업 파일이 아닙니다.'); }
  if (!value || typeof value !== 'object' || value.format !== BACKUP_FORMAT) throw new BackupError('Tower 백업 파일이 아닙니다.');
  if (value.version !== 1) throw new BackupError('이 Tower보다 새 버전이 만든 백업입니다. Tower를 업데이트한 뒤 복원하세요.');
  const kdf = value.kdf;
  // Bounded, so a crafted file cannot make the key derivation take minutes or gigabytes.
  if (!kdf || kdf.name !== 'scrypt' || !whole(kdf.N, 16_384, 1_048_576) || (kdf.N & (kdf.N - 1)) !== 0 || !whole(kdf.r, 1, 16) || !whole(kdf.p, 1, 4) || !base64(kdf.salt, 16)
    || value.cipher !== 'aes-256-gcm' || !base64(value.iv, 12) || !base64(value.tag, 16) || !base64(value.data)
    || typeof value.createdAt !== 'string' || typeof value.towerVersion !== 'string' || typeof value.from !== 'string') throw new BackupError('백업 파일이 손상되었습니다.');
  return value as BackupEnvelope;
}

export async function decryptBackup(text: string, passphrase: string): Promise<{ header: BackupHeader; payload: unknown }> {
  const envelope = readBackupHeader(text);
  const { tag, data, ...header } = envelope;
  const key = await deriveKey(checkPassphrase(passphrase), Buffer.from(header.kdf.salt, 'base64'), header.kdf);
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    decipher.setAAD(additionalData(header));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]);
  } catch { throw new BackupError('암호가 맞지 않거나 백업 파일이 손상되었습니다.'); }
  let payload: unknown;
  try { payload = JSON.parse(gunzipSync(plain, { maxOutputLength: MAX_PLAIN_BYTES }).toString('utf8')); }
  catch { throw new BackupError('백업 파일이 손상되었습니다.'); }
  return { header, payload };
}
