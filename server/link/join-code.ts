import { z } from 'zod';

/** A join code: what a computer needs to connect to a controller once. Made by the controller, used once, within ten minutes. */
export interface JoinCode {
  v: 1;
  /** The controller's name, shown before connecting. */
  name: string;
  /** The controller's pinned key. The joining computer refuses any other. */
  pin: string;
  /** Where the controller's link port can be reached, tried in order. */
  addresses: string[];
  inviteId: string;
  /** Proves the joining computer received this code. */
  secret: string;
  expiresAt: number;
  /** The Tower version the controller runs; the joining computer installs the same one. */
  version: string;
}

export const JOIN_PREFIX = 'tower-link:';
const MAX_CODE_LENGTH = 4096;
const address = z.string().max(300).refine(value => {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/tower-link';
  } catch { return false; }
}, 'Expected a ws or wss link address.');
const schema = z.object({
  v: z.literal(1),
  name: z.string().min(1).max(100),
  pin: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  addresses: z.array(address).min(1).max(8),
  inviteId: z.string().regex(/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/),
  secret: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.number().int().positive(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
}).strict();

export function encodeJoinCode(code: JoinCode): string {
  return `${JOIN_PREFIX}${Buffer.from(JSON.stringify(schema.parse(code))).toString('base64url')}`;
}

/** Throws for anything that is not a well-formed join code. Expiry is checked by the caller against its own clock. */
export function decodeJoinCode(text: unknown): JoinCode {
  if (typeof text !== 'string') throw invalidCode();
  const trimmed = text.trim();
  if (!trimmed.startsWith(JOIN_PREFIX) || trimmed.length > MAX_CODE_LENGTH) throw invalidCode();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(trimmed.slice(JOIN_PREFIX.length), 'base64url').toString('utf8')); } catch { throw invalidCode(); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidCode();
  return parsed.data;
}

function invalidCode() { return Object.assign(new Error('Tower 연결 코드가 아닙니다. 다른 컴퓨터에서 코드 전체를 복사하세요.'), { statusCode: 400 }); }

/** A released version's package as its release publishes it: built, so installing it needs no Git and no compiler. */
export const releasePackage = (version: string) => `https://github.com/kimwz/agent-session-tower/releases/download/v${version}/agent-session-tower-${version}.tgz`;

const published = new Map<string, true | number>();
/** Whether a version's release package can be downloaded yet. Once it can, it stays so; a missing one is looked for again after a minute. */
export async function releasePublished(version: string): Promise<boolean> {
  const known = published.get(version);
  if (known === true) return true;
  if (typeof known === 'number' && Date.now() - known < 60_000) return false;
  const found = await fetch(releasePackage(version), { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(3000) }).then(response => response.ok, () => false);
  published.set(version, found || Date.now());
  return found;
}

/**
 * The command that joins a computer, installing the controller's Tower version first: its release's package once that
 * is published (a release publishes it a few minutes after the version is tagged), its source until then.
 */
export function joinCommand(code: JoinCode, published = false): string {
  return `npx --yes ${published ? releasePackage(code.version) : `github:kimwz/agent-session-tower#v${code.version}`} join ${encodeJoinCode(code)}`;
}
