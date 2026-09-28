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
/** How long a reference may be used in a request. The value itself stays hidden for as long as the host runs. */
const LIFETIME_MS = 30 * 60_000;
/** Values kept to hide; the oldest go first past this. */
const MAX_KEPT = 1000;
/** Values shorter than this are not searched for in text: they would match ordinary words. */
const SHORTEST_KNOWN = 4;

/**
 * Where each request takes a secret: the only fields a reference is put back into, as `a.b` key paths. Anywhere
 * else (a title, a prompt, a secret's name or address) Tower would keep or show it openly, so it is refused. Routes
 * are matched after `/api/nodes/<id>` is removed.
 */
const SECRET_REQUEST_FIELDS: Array<{ route: RegExp; fields: string[] }> = [
  { route: /^\/api\/slack\/connect$/, fields: ['appToken', 'userToken'] },
  { route: /^\/api\/decisions\/settings$/, fields: ['apiKey'] },
  { route: /^\/api\/public-agents\/(create|password)$/, fields: ['password'] },
  { route: /^\/api\/auth\/credentials$/, fields: ['password'] },
  { route: /^\/api\/v1\/secrets\.create$/, fields: ['secret.value'] },
  { route: /^\/api\/link\/join$/, fields: ['code'] },
];

/**
 * Responses whose fields are secrets by nature: shown to the owner, never to the model. Paths are matched after
 * `/api/nodes/<id>` is removed, so a joined computer's answers are treated the same way.
 */
const SECRET_FIELDS: Array<{ path: RegExp; fields: string[] }> = [
  // A join code lets any computer that holds it pair with this one.
  { path: /^\/api\/link\/invite$/, fields: ['code', 'command'] },
];

const localRoute = (route: string) => route.replace(/^\/api\/nodes\/[a-f0-9]{32}\//, '/api/');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Keeps secret values out of what the model reads and writes. Each value becomes `{{secret:<ref>}}`; the reference
 * is swapped back only into a request's secret field, just before it is sent. Values live in memory only.
 */
export class SecretVault {
  private readonly values = new Map<string, { value: string; at: number }>();
  private known?: { pattern: RegExp; refs: Map<string, string> };

  /** Replaces recognised secrets in text with references, and every value already kept wherever it appears. */
  hide(text: string): string {
    const found = outsideReferences(text, part => PATTERNS.reduce((result, pattern) => result.replace(pattern, match => `{{secret:${this.keep(match)}}}`), part));
    return this.redact(found);
  }

  /** Replaces only the values already kept (pasted keys, a secret card's value), whatever the settings. */
  redact(text: string): string {
    const known = this.knownValues();
    return known ? outsideReferences(text, part => part.replace(known.pattern, match => `{{secret:${known.refs.get(match)}}}`)) : text;
  }

  /** `redact` over any JSON value. */
  redactInResponse(value: unknown): unknown {
    const walk = (item: unknown): unknown => typeof item === 'string' ? this.redact(item) : Array.isArray(item) ? item.map(walk)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)])) : item;
    return walk(value);
  }

  /** Hides secrets in any JSON value, including the fields of `path`'s answer that are secret by nature. */
  hideInResponse(path: string, value: unknown): unknown {
    const fields = SECRET_FIELDS.find(item => item.path.test(localRoute(path)))?.fields ?? [];
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
   * Puts the values back into the body of a request to `route`, only in that request's secret fields; an unknown
   * or expired reference, or one anywhere else, is an error.
   */
  reveal(value: unknown, route: string): unknown {
    const allowed = SECRET_REQUEST_FIELDS.find(item => item.route.test(localRoute(route)))?.fields ?? [];
    const walk = (item: unknown, path: string[]): unknown => {
      if (typeof item === 'string') {
        if (!item.match(REFERENCE)) return item;
        if (!allowed.includes(path.join('.'))) {
          throw Object.assign(new Error(allowed.length ? `비밀 값 참조는 이 요청의 비밀 칸(${allowed.join(', ')})에만 넣을 수 있습니다.` : '이 요청에는 비밀 값을 넣을 칸이 없습니다.'), { statusCode: 400 });
        }
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
    // The oldest value goes first; a Map keeps the order values were first kept.
    while (this.values.size > MAX_KEPT) this.values.delete(this.values.keys().next().value!);
    this.known = undefined;
    return ref;
  }

  /** One pattern for every kept value, longest first, so a value inside a longer one never leaves a remainder. */
  private knownValues(): { pattern: RegExp; refs: Map<string, string> } | undefined {
    if (this.known) return this.known;
    const refs = new Map<string, string>();
    for (const [ref, known] of this.values) if (known.value.length >= SHORTEST_KNOWN) refs.set(known.value, ref);
    if (!refs.size) return undefined;
    const pattern = new RegExp([...refs.keys()].sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
    return this.known = { pattern, refs };
  }
}

/** Applies `change` to the text between references, so a reference is never altered by what replaces values. */
function outsideReferences(text: string, change: (part: string) => string): string {
  let result = '';
  let last = 0;
  for (const match of text.matchAll(REFERENCE)) {
    result += change(text.slice(last, match.index)) + match[0];
    last = match.index! + match[0].length;
  }
  return result + change(text.slice(last));
}
