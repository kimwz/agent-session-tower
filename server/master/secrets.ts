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

  /** Replaces recognised secrets in text with references. */
  hide(text: string): string {
    this.prune();
    let result = text;
    for (const pattern of PATTERNS) result = result.replace(pattern, match => `{{secret:${this.keep(match)}}}`);
    return result;
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

  /** Puts the values back into a request body; an unknown or expired reference is an error. */
  reveal(value: unknown): unknown {
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return item.replace(REFERENCE, (_match, ref: string) => {
        const known = this.values.get(ref);
        if (!known || Date.now() - known.at > LIFETIME_MS) throw Object.assign(new Error('비밀 값 참조가 만료되었습니다. 값을 다시 입력해 달라고 요청하세요.'), { statusCode: 400 });
        return known.value;
      });
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
      return item;
    };
    return walk(value);
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
