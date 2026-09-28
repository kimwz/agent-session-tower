import { randomBytes } from 'node:crypto';

/**
 * Key and token formats kept out of the model's context: OpenAI, Anthropic, Slack, GitHub, AWS, Google and
 * Jev-style bearer keys. Matching is best effort; a secret in an unknown format is not recognised.
 */
// A key starts after anything but a letter or digit (`_`, `=`, a quote), so `TOKEN_sk-…` or `KEY=AKIA…` is found too.
const PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])sk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{30,}/g,
  /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{40,}/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])jev_[A-Za-z0-9_-]{16,}/g,
];
const REFERENCE = /\{\{secret:([a-f0-9]{16})\}\}/g;
/** How long a reference may be used in a request. The value itself stays hidden for as long as the host runs. */
const LIFETIME_MS = 30 * 60_000;
/** Values found by their format that are kept to put back; past this the least recently seen go, oldest first. */
const MAX_FOUND = 20_000;
/** Secret-by-nature values from answers (join codes) hidden everywhere; the oldest go first past this. */
const MAX_ANSWERED = 200;
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

interface Kept { value: string; at: number; source: 'owner' | 'answer' | 'format' }

/**
 * Keeps secret values out of what the model reads and writes. Each value becomes `{{secret:<ref>}}`; the reference
 * is swapped back only into a request's secret field, just before it is sent. Values live in memory only.
 *
 * Values the owner gave on purpose (a secret card) are hidden wherever they show up, for as long as the host runs,
 * and are never dropped; so are values secret by nature in an answer (a join code), the latest `MAX_ANSWERED`.
 * Values found by their format (a pasted key, a key in an answer) are hidden by that format wherever it shows; they
 * are kept so their reference can be put back, the latest `MAX_FOUND`. Hiding is best effort: a secret in an
 * unknown format that the owner did not give through a card is not recognised.
 */
export class SecretVault {
  private readonly given = new Map<string, Kept>();
  private readonly found = new Map<string, Kept>();
  /** Each kept value's reference, of either kind. */
  private readonly refs = new Map<string, string>();
  private givenPattern?: RegExp;

  /** Hides the owner's given values first (whole, so no format inside one splits it), then recognised formats. */
  hide(text: string): string {
    return outsideReferences(this.redact(text), part => PATTERNS.reduce((result, pattern) => result.replace(pattern, match => `{{secret:${this.keep(match, 'format')}}}`), part));
  }

  /** Hides only the values the owner gave, whatever the settings: they are never shown back. */
  redact(text: string): string {
    const pattern = this.pattern();
    return pattern ? outsideReferences(text, part => part.replace(pattern, match => `{{secret:${this.refs.get(match)}}}`)) : text;
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
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, fields.includes(key) && typeof child === 'string' ? `{{secret:${this.keep(child, 'answer')}}}` : walk(child)]));
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
          const kept = this.given.get(ref) ?? this.found.get(ref);
          if (!kept || Date.now() - kept.at > LIFETIME_MS) throw Object.assign(new Error('비밀 값 참조가 만료되었습니다. 값을 다시 입력해 달라고 요청하세요.'), { statusCode: 400 });
          return kept.value;
        });
      }
      if (Array.isArray(item)) return item.map(child => walk(child, path));
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child, [...path, key])]));
      return item;
    };
    return walk(value, []);
  }

  /** A reference for a value the owner gave on purpose (a secret card), whatever its format. */
  reference(value: string): string { return `{{secret:${this.keep(value, 'owner')}}}`; }

  private keep(value: string, source: Kept['source']): string {
    const given = source !== 'format';
    const known = this.refs.get(value);
    if (known) {
      const kept = this.given.get(known) ?? this.found.get(known)!;
      kept.at = Date.now();
      // Seen again, it becomes the most recent of its kind; a value the owner gives is theirs from now on.
      const was = this.given.has(known) ? this.given : this.found;
      was.delete(known);
      if (given && (kept.source === 'format' || source === 'owner')) kept.source = source;
      (kept.source === 'format' ? this.found : this.given).set(known, kept);
      if (was !== this.found || kept.source !== 'format') this.givenPattern = undefined;
      this.trim();
      return known;
    }
    const ref = randomBytes(8).toString('hex');
    (given ? this.given : this.found).set(ref, { value, at: Date.now(), source });
    this.refs.set(value, ref);
    if (given) this.givenPattern = undefined;
    this.trim();
    return ref;
  }

  /** Drops the oldest found values and the oldest answered ones past their limits; the owner's own values stay. */
  private trim(): void {
    while (this.found.size > MAX_FOUND) {
      const [oldest, kept] = this.found.entries().next().value!;
      this.found.delete(oldest);
      this.refs.delete(kept.value);
    }
    const answered = [...this.given].filter(([, kept]) => kept.source === 'answer');
    for (const [ref, kept] of answered.slice(0, Math.max(0, answered.length - MAX_ANSWERED))) {
      this.given.delete(ref);
      this.refs.delete(kept.value);
      this.givenPattern = undefined;
    }
  }

  /** One pattern for every given value, longest first, so a value inside a longer one never leaves a remainder. */
  private pattern(): RegExp | undefined {
    if (this.givenPattern) return this.givenPattern;
    const values = [...this.given.values()].map(kept => kept.value).filter(value => value.length >= SHORTEST_KNOWN);
    if (!values.length) return undefined;
    return this.givenPattern = new RegExp(values.sort((a, b) => b.length - a.length).map(escape).join('|'), 'g');
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
