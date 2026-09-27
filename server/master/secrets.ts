import { randomBytes } from 'node:crypto';

/**
 * Key and token formats kept out of the model's context: OpenAI, Anthropic, Slack, GitHub, AWS, Google and
 * Jev-style bearer keys. Matching is best effort; a secret in an unknown format is not recognised.
 */
const PATTERNS: RegExp[] = [
  /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{10,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bjev_[A-Za-z0-9_-]{16,}/g,
];
const REFERENCE = /\{\{secret:([a-f0-9]{16})\}\}/g;
const LIFETIME_MS = 30 * 60_000;
/**
 * Request fields a secret may go into. A reference anywhere else is refused, so a value never lands where Tower
 * keeps or shows it openly (a title, a prompt) and comes back to the model from there.
 */
const SECRET_FIELD = /token|secret|password|passphrase|credential|api[_-]?key|^key$|^code$|authorization/i;
/** Values shorter than this are not searched for in text: they would match ordinary words. */
const SHORTEST_KNOWN = 4;

/**
 * Responses whose fields are secrets by nature: shown to the owner, never to the model. Paths are matched after
 * `/api/nodes/<id>` is removed, so a joined computer's answers are treated the same way.
 */
const SECRET_FIELDS: Array<{ path: RegExp; fields: string[] }> = [
  // A join code lets any computer that holds it pair with this one.
  { path: /^\/api\/link\/invite$/, fields: ['code', 'command'] },
];

/**
 * Keeps secret values out of what the model reads and writes. Each value becomes `{{secret:<ref>}}`; the reference
 * is swapped back only in the body of a request to Tower, just before it is sent.
 */
export class SecretVault {
  private readonly values = new Map<string, { value: string; at: number }>();

  /** Replaces recognised secrets in text with references, and every value the owner gave wherever it appears. */
  hide(text: string): string {
    this.prune();
    let result = text;
    for (const pattern of PATTERNS) result = result.replace(pattern, match => `{{secret:${this.keep(match)}}}`);
    return this.redact(result);
  }

  /** Replaces only the values the owner gave (a secret card), whatever the settings: they are never shown back. */
  redact(text: string): string {
    let result = text;
    for (const [ref, known] of this.values) if (known.value.length >= SHORTEST_KNOWN && result.includes(known.value)) result = result.split(known.value).join(`{{secret:${ref}}}`);
    return result;
  }

  /** `redact` over any JSON value. */
  redactInResponse(value: unknown): unknown {
    const walk = (item: unknown): unknown => typeof item === 'string' ? this.redact(item) : Array.isArray(item) ? item.map(walk)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)])) : item;
    return walk(value);
  }

  /** Hides secrets in any JSON value, including the fields of `path`'s answer that are secret by nature. */
  hideInResponse(path: string, value: unknown): unknown {
    const local = path.replace(/^\/api\/nodes\/[a-f0-9]{32}\//, '/api/');
    const fields = SECRET_FIELDS.find(item => item.path.test(local))?.fields ?? [];
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.hide(item);
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object') {
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, fields.includes(key) && typeof child === 'string' ? `{{secret:${this.keep(child)}}}` : walk(child)]));
      }
      return item;
    };
    return walk(value);
  }

  /**
   * Puts the values back into a request body, only in fields meant for secrets (a token, a password, a key, or
   * anything under a `secret` field); an unknown or expired reference, or one anywhere else, is an error.
   */
  reveal(value: unknown): unknown {
    const walk = (item: unknown, path: string[]): unknown => {
      if (typeof item === 'string') {
        if (!item.match(REFERENCE)) return item;
        if (!path.some(key => SECRET_FIELD.test(key))) throw Object.assign(new Error('비밀 값 참조는 토큰, 비밀번호, 키 같은 비밀 칸에만 넣을 수 있습니다.'), { statusCode: 400 });
        return item.replace(REFERENCE, (_match, ref: string) => {
          const known = this.values.get(ref);
          if (!known || Date.now() - known.at > LIFETIME_MS) throw Object.assign(new Error('비밀 값 참조가 만료되었습니다. 값을 다시 입력해 달라고 요청하세요.'), { statusCode: 400 });
          return known.value;
        });
      }
      if (Array.isArray(item)) return item.map(child => walk(child, path));
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child, [...path, key])]));
      return item;
    };
    return walk(value, []);
  }

  /** A reference for a value the owner gave on purpose (a secret card), whatever its format. */
  reference(value: string): string { return `{{secret:${this.keep(value)}}}`; }

  private keep(value: string): string {
    for (const [ref, known] of this.values) if (known.value === value) { known.at = Date.now(); return ref; }
    const ref = randomBytes(8).toString('hex');
    this.values.set(ref, { value, at: Date.now() });
    return ref;
  }
  private prune(): void {
    const now = Date.now();
    for (const [ref, known] of this.values) if (now - known.at > LIFETIME_MS) this.values.delete(ref);
  }
}
