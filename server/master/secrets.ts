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
/** How long a reference may be used in a request. A value the owner gave stays hidden for as long as the host runs. */
const LIFETIME_MS = 30 * 60_000;
/**
 * How many keys found by their format are kept to put back: those the owner pasted, and those read in answers and
 * files. None is dropped before its reference expires; past the limit a further key is still hidden, under a
 * reference that cannot be put back.
 */
const MAX_PASTED = 1_000;
const MAX_READ = 20_000;
/** Secret-by-nature values from answers (join codes) hidden everywhere; the oldest go first past this. */
const MAX_ANSWERED = 200;
/** Values typed into secret cards while the host runs; a card takes no more past this (none is ever dropped). */
const MAX_CARDS = 200;
/** Values shorter than this are not searched for in text: they would match ordinary words. A card takes no shorter value. */
export const SHORTEST_SECRET = 8;

/**
 * Where each request takes a secret: the only fields a reference is put back into, as exact key paths (array items
 * are not fields). Anywhere else (a title, a prompt, a secret's name or address) Tower would keep or show it openly,
 * so it is refused. Routes are matched after `/api/nodes/<id>` is removed.
 */
const SECRET_REQUEST_FIELDS: Array<{ route: RegExp; fields: string[][] }> = [
  { route: /^\/api\/slack\/connect$/, fields: [['appToken'], ['userToken']] },
  { route: /^\/api\/decisions\/settings$/, fields: [['apiKey']] },
  { route: /^\/api\/public-agents\/(create|password)$/, fields: [['password']] },
  { route: /^\/api\/auth\/credentials$/, fields: [['password']] },
  { route: /^\/api\/v1\/secrets\.create$/, fields: [['secret', 'value']] },
  { route: /^\/api\/link\/join$/, fields: [['code']] },
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

/** Where a value came from: a secret card, a secret-by-nature answer field, a key the owner pasted, or one read. */
type Source = 'card' | 'answer' | 'pasted' | 'read';
interface Kept { value: string; at: number; source: Source }
const HIDDEN_EVERYWHERE: ReadonlySet<Source> = new Set(['card', 'answer']);

/**
 * Keeps secret values out of what the model reads and writes. Each value becomes `{{secret:<ref>}}`; the reference
 * is swapped back only into a request's exact secret field, just before it is sent. Values live in memory only.
 *
 * A value the owner typed into a secret card is hidden wherever it shows up, in text and in the names and values of
 * answers, for as long as the host runs, and is never dropped; so are secret-by-nature values in answers (join
 * codes), the latest `MAX_ANSWERED`. Keys found by their format, pasted by the owner or read, are hidden by that
 * format wherever it shows, and kept so their reference can be put back until it expires. Hiding is best effort: a
 * secret in an unknown format that did not come through a card is not recognised.
 */
export class SecretVault {
  /** Every kept value by reference; a Map keeps the order values were last seen. */
  private readonly kept = new Map<string, Kept>();
  /** Each kept value's reference. */
  private readonly refs = new Map<string, string>();
  private readonly counts: Record<Source, number> = { card: 0, answer: 0, pasted: 0, read: 0 };
  /** References given out for keys hidden while full, which cannot be put back but are still references. */
  private readonly issued = new Set<string>();
  private everywhere?: RegExp | null;

  /**
   * Hides the values the owner gave first (whole, so no format inside one splits it), then recognised formats. In the
   * owner's own message (`source` 'pasted') a recognised key is kept as theirs.
   */
  hide(text: string, source: 'pasted' | 'read' = 'read'): string {
    return this.outsideReferences(this.redact(text), part => PATTERNS.reduce((result, pattern) => result.replace(pattern, match => `{{secret:${this.keep(match, source)}}}`), part));
  }

  /** Hides only the values hidden everywhere (cards, secret answer fields), whatever the settings. */
  redact(text: string): string {
    const pattern = this.pattern();
    return pattern ? this.outsideReferences(text, part => part.replace(pattern, match => `{{secret:${this.refs.get(match)}}}`)) : text;
  }

  /**
   * Applies `change` to the text around the references this vault gave out, so none of them is altered by what
   * replaces values. Text that only looks like a reference is text like any other.
   */
  private outsideReferences(text: string, change: (part: string) => string): string {
    let result = '';
    let last = 0;
    for (const match of text.matchAll(REFERENCE)) {
      if (!this.kept.has(match[1]) && !this.issued.has(match[1])) continue;
      result += change(text.slice(last, match.index)) + match[0];
      last = match.index! + match[0].length;
    }
    return result + change(text.slice(last));
  }

  /** `redact` over any JSON value, names of fields included. */
  redactInResponse(value: unknown): unknown {
    const walk = (item: unknown): unknown => typeof item === 'string' ? this.redact(item) : Array.isArray(item) ? item.map(walk)
      : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [this.redact(key), walk(child)])) : item;
    return walk(value);
  }

  /** Hides secrets in any JSON value, names of fields included, and the fields of `path`'s answer secret by nature. */
  hideInResponse(path: string, value: unknown): unknown {
    const fields = SECRET_FIELDS.find(item => item.path.test(localRoute(path)))?.fields ?? [];
    const walk = (item: unknown): unknown => {
      if (typeof item === 'string') return this.hide(item);
      if (Array.isArray(item)) return item.map(walk);
      if (item && typeof item === 'object') {
        return Object.fromEntries(Object.entries(item).map(([key, child]) => [this.hide(key), fields.includes(key) && typeof child === 'string' ? `{{secret:${this.keep(child, 'answer')}}}` : walk(child)]));
      }
      return item;
    };
    return walk(value);
  }

  /**
   * Puts the values back into the body of a request to `route`, only in that request's exact secret fields; an
   * unknown or expired reference, or one anywhere else, is an error.
   */
  reveal(value: unknown, route: string): unknown {
    const allowed = (SECRET_REQUEST_FIELDS.find(item => item.route.test(localRoute(route)))?.fields ?? []).map(path => JSON.stringify(path));
    const walk = (item: unknown, path: Array<string | number>): unknown => {
      if (typeof item === 'string') {
        if (!item.match(REFERENCE)) return item;
        if (!allowed.includes(JSON.stringify(path))) {
          const names = (SECRET_REQUEST_FIELDS.find(entry => entry.route.test(localRoute(route)))?.fields ?? []).map(field => field.join('.'));
          throw Object.assign(new Error(names.length ? `비밀 값 참조는 이 요청의 비밀 칸(${names.join(', ')})에만 넣을 수 있습니다.` : '이 요청에는 비밀 값을 넣을 칸이 없습니다.'), { statusCode: 400 });
        }
        return item.replace(REFERENCE, (_match, ref: string) => {
          const kept = this.kept.get(ref);
          if (!kept || Date.now() - kept.at > LIFETIME_MS) throw Object.assign(new Error('비밀 값 참조가 만료되었습니다. 값을 다시 입력해 달라고 요청하세요.'), { statusCode: 400 });
          return kept.value;
        });
      }
      if (Array.isArray(item)) return item.map((child, index) => walk(child, [...path, index]));
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child, [...path, key])]));
      return item;
    };
    return walk(value, []);
  }

  /** A reference for a value the owner typed into a secret card, whatever its format; none past `MAX_CARDS`. */
  reference(value: string): string {
    const known = this.refs.get(value);
    if (!(known && this.kept.get(known)!.source === 'card') && this.counts.card >= MAX_CARDS) {
      throw Object.assign(new Error('이번 마스터 실행에서 받을 수 있는 비밀 값 수를 넘었습니다. Tower 화면에서 직접 입력해 주세요.'), { statusCode: 409 });
    }
    return `{{secret:${this.keep(value, 'card')}}}`;
  }

  private keep(value: string, source: Source): string {
    const now = Date.now();
    const known = this.refs.get(value);
    if (known) {
      const kept = this.kept.get(known)!;
      // A value seen again is the most recent; one the owner now gives on a card is theirs from then on.
      this.kept.delete(known);
      kept.at = now;
      if (rank(source) > rank(kept.source) && this.room(source)) {
        this.counts[kept.source]--;
        this.counts[source]++;
        kept.source = source;
        if (HIDDEN_EVERYWHERE.has(source)) this.everywhere = undefined;
      }
      this.kept.set(known, kept);
      return known;
    }
    const ref = randomBytes(8).toString('hex');
    // Full of references still in use: the key is hidden all the same, under a reference that cannot be put back.
    if (!this.room(source)) {
      this.issued.add(ref);
      if (this.issued.size > MAX_READ) this.issued.delete(this.issued.values().next().value!);
      return ref;
    }
    this.kept.set(ref, { value, at: now, source });
    this.refs.set(value, ref);
    this.counts[source]++;
    if (HIDDEN_EVERYWHERE.has(source)) this.everywhere = undefined;
    return ref;
  }

  /** Whether one more value of `source` can be kept, dropping what its rule allows first. */
  private room(source: Source): boolean {
    const limit = source === 'pasted' ? MAX_PASTED : source === 'read' ? MAX_READ : source === 'answer' ? MAX_ANSWERED : MAX_CARDS;
    if (this.counts[source] < limit) return true;
    // Join codes: the oldest goes. Keys: those whose reference expired go. Card values: none ever goes.
    if (source !== 'card') this.drop(source, source === 'answer' ? Infinity : LIFETIME_MS);
    return this.counts[source] < limit;
  }

  /** Drops values of `source` not seen for longer than `olderThan` (join codes: the oldest one), oldest first. */
  private drop(source: Source, olderThan: number): void {
    const now = Date.now();
    for (const [ref, kept] of this.kept) {
      if (kept.source !== source) continue;
      if (olderThan !== Infinity && now - kept.at <= olderThan) break;
      this.kept.delete(ref);
      this.refs.delete(kept.value);
      this.counts[source]--;
      if (HIDDEN_EVERYWHERE.has(source)) this.everywhere = undefined;
      if (olderThan === Infinity) break;
    }
  }

  /** One pattern for every value hidden everywhere, longest first, so a value inside a longer one leaves no remainder. */
  private pattern(): RegExp | undefined {
    if (this.everywhere !== undefined) return this.everywhere ?? undefined;
    const values = [...this.kept.values()].filter(kept => HIDDEN_EVERYWHERE.has(kept.source) && kept.value.length >= SHORTEST_SECRET).map(kept => kept.value);
    this.everywhere = values.length ? new RegExp(values.sort((a, b) => b.length - a.length).map(escape).join('|'), 'g') : null;
    return this.everywhere ?? undefined;
  }
}

/** Which source a value counts as when seen from several: a card is the strongest claim. */
function rank(source: Source): number { return source === 'card' ? 3 : source === 'answer' ? 2 : source === 'pasted' ? 1 : 0; }
