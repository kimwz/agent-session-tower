import type { SlackFile, SlackMessage } from '../../shared/slack.js';
export type { SlackMessage } from '../../shared/slack.js';

export interface SlackClientDependencies {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(`Slack API: ${code}`);
    this.name = 'SlackApiError';
  }
}

/** Integrations such as GitHub post their content only in legacy attachments, so a thread reader must include them. */
function attachmentText(attachments: unknown): string {
  if (!Array.isArray(attachments)) return '';
  const field = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  return attachments.slice(0, 20).map(attachment => {
    if (!attachment || typeof attachment !== 'object') return '';
    const item = attachment as Record<string, unknown>;
    const title = field(item.title);
    const link = field(item.title_link);
    const fields = Array.isArray(item.fields) ? item.fields.map(value => value && typeof value === 'object'
      ? [field((value as Record<string, unknown>).title), field((value as Record<string, unknown>).value)].filter(Boolean).join(': ') : '') : [];
    return [field(item.pretext), field(item.author_name), title && link && !title.includes(link) ? `<${link}|${title}>` : title,
      field(item.text), ...fields, field(item.footer)].filter(Boolean).join('\n') || field(item.fallback);
  }).filter(Boolean).join('\n\n');
}

/** Files on a message as metadata; a file without an ID (a tombstone or one hidden by plan limits) cannot be read. */
function messageFiles(files: unknown): SlackFile[] | undefined {
  if (!Array.isArray(files)) return undefined;
  const parsed = files.slice(0, 20).flatMap((file): SlackFile[] => {
    if (!file || typeof file !== 'object' || typeof file.id !== 'string' || !file.id || file.id.length > 200) return [];
    const name = [file.name, file.title, file.id].find(value => typeof value === 'string' && value.trim()) as string;
    return [{ id: file.id, name: name.trim().slice(0, 500), mimetype: typeof file.mimetype === 'string' ? file.mimetype.slice(0, 200) : '',
      size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0 }];
  });
  return parsed.length ? parsed : undefined;
}

/** Slack serves a file only from its own hosts, so the token goes to no other host, redirects included. */
const slackHost = (url: URL) => url.protocol === 'https:' && (url.hostname === 'slack.com' || url.hostname.endsWith('.slack.com'));

/** Reads a body up to `max` bytes, chunked bodies included; nothing when it is longer. */
async function readBounded(response: Response, max: number): Promise<Buffer | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > max) { await reader.cancel(); return undefined; }
    chunks.push(value);
  }
}

function messageText(message: Record<string, any>): string {
  const text = typeof message.text === 'string' ? message.text : '';
  const attached = attachmentText(message.attachments);
  if (!attached) return text;
  return text.trim() ? `${text}\n\n${attached}` : attached;
}

const safeErrors = new Set(['file_not_found', 'file_deleted', 'invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'missing_scope', 'not_in_channel', 'channel_not_found', 'thread_not_found', 'ratelimited', 'is_archived', 'restricted_action', 'invalid_name', 'too_many_reactions', 'message_not_found', 'already_reacted', 'no_reaction']);

export class SlackClient {
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly token: string, deps: SlackClientDependencies = {}) {
    this.fetcher = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async call(method: string, parameters: Record<string, string>, read: boolean, token = this.token): Promise<Record<string, any>> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`https://slack.com/api/${method}`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams(parameters), signal: AbortSignal.timeout(20_000), redirect: 'error',
        });
      } catch { throw new SlackApiError('network_error'); }
      if (response.status === 429) {
        const seconds = Number(response.headers.get('retry-after') ?? '1');
        if (read && attempt < 2 && Number.isFinite(seconds) && seconds >= 0 && seconds <= 30) {
          await response.body?.cancel();
          await this.sleep(Math.max(1, seconds) * 1000);
          continue;
        }
        throw new SlackApiError('ratelimited');
      }
      if (!response.ok) throw new SlackApiError('http_error');
      let body: Record<string, any>;
      try {
        // Bound responses before JSON parsing.
        const content = response.body ? await readBounded(response, 2_000_000) : undefined;
        if (!content) throw new Error();
        body = JSON.parse(content.toString('utf8'));
        if (!body || typeof body !== 'object') throw new Error();
      } catch { throw new SlackApiError('invalid_response'); }
      if (!body.ok) throw new SlackApiError(safeErrors.has(body.error) ? body.error : 'request_failed');
      return body;
    }
  }

  async auth(): Promise<{ teamId: string; userId: string; teamName?: string; userName?: string }> {
    const data = await this.call('auth.test', {}, true);
    if (typeof data.team_id !== 'string' || typeof data.user_id !== 'string') throw new SlackApiError('invalid_response');
    return { teamId: data.team_id, userId: data.user_id, teamName: data.team, userName: data.user };
  }

  async thread(channel: string, ts: string): Promise<SlackMessage[]> {
    const messages: SlackMessage[] = [];
    const seenCursors = new Set<string>();
    let cursor = '';
    let totalCharacters = 0;
    for (let page = 0; page < 100; page++) {
      const data = await this.call('conversations.replies', { channel, ts, limit: '100', ...(cursor ? { cursor } : {}) }, true);
      if (!Array.isArray(data.messages)) throw new SlackApiError('invalid_response');
      for (const message of data.messages) {
        if (typeof message?.ts !== 'string') throw new SlackApiError('invalid_response');
        const text = messageText(message);
        totalCharacters += text.length;
        const files = messageFiles(message.files);
        messages.push({ ts: message.ts, text, user: typeof message.user === 'string' ? message.user : typeof message.bot_id === 'string' ? message.bot_id : 'unknown', ...(files ? { files } : {}) });
      }
      if (messages.length > 1000 || totalCharacters > 200_000) throw new SlackApiError('thread_too_large');
      cursor = typeof data.response_metadata?.next_cursor === 'string' ? data.response_metadata.next_cursor.trim() : '';
      if (!cursor) {
        if (data.has_more) throw new SlackApiError('incomplete_thread');
        return messages;
      }
      if (seenCursors.has(cursor)) throw new SlackApiError('incomplete_thread');
      seenCursors.add(cursor);
    }
    throw new SlackApiError('thread_too_large');
  }

  /** Where a file is downloaded from, read fresh: it needs `files:read`, and a deleted file is reported as such. */
  async fileInfo(id: string): Promise<{ name: string; mimetype: string; size: number; url?: string; external: boolean }> {
    const data = await this.call('files.info', { file: id }, true);
    const file = data.file;
    if (!file || typeof file !== 'object' || file.id !== id) throw new SlackApiError('invalid_response');
    const url = [file.url_private_download, file.url_private].find(value => typeof value === 'string' && value);
    return { name: typeof file.name === 'string' ? file.name : '', mimetype: typeof file.mimetype === 'string' ? file.mimetype : '',
      size: Number.isSafeInteger(file.size) && file.size >= 0 ? file.size : 0, ...(url ? { url } : {}), external: file.is_external === true };
  }

  /** A private file's bytes, at most `maxBytes`. Redirects are followed by hand and only to Slack hosts. */
  async download(url: string, maxBytes: number): Promise<{ content: Buffer; contentType: string }> {
    let target: URL;
    try { target = new URL(url); } catch { throw new SlackApiError('outside_slack'); }
    for (let hop = 0; ; hop++) {
      if (!slackHost(target)) throw new SlackApiError(hop ? 'redirect_outside_slack' : 'outside_slack');
      let response: Response;
      try {
        response = await this.fetcher(target.toString(), { headers: { Authorization: `Bearer ${this.token}` }, redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      } catch { throw new SlackApiError('network_error'); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || hop >= 3) throw new SlackApiError('http_error');
        try { target = new URL(location, target); } catch { throw new SlackApiError('redirect_outside_slack'); }
        continue;
      }
      if (response.status === 429) { await response.body?.cancel(); throw new SlackApiError('ratelimited'); }
      if (!response.ok) { await response.body?.cancel(); throw new SlackApiError(response.status === 404 ? 'file_not_found' : 'http_error'); }
      let content: Buffer | undefined;
      try { content = await readBounded(response, maxBytes); } catch { throw new SlackApiError('network_error'); }
      if (!content) throw new SlackApiError('too_large');
      return { content, contentType: response.headers.get('content-type') ?? '' };
    }
  }

  /** Bounded owner-only search. Never consume adjacent/context messages. */
  async searchOwnMessages(userId: string, excluded: Set<string>, now = Date.now()): Promise<string[]> {
    if (!/^[A-Z0-9]+$/.test(userId)) throw new SlackApiError('invalid_response');
    const after = now - 90 * 86400_000;
    const texts: string[] = []; let characters = 0; const seen = new Set<string>();
    for (let page = 1; page <= 2; page++) {
      const data = await this.call('search.messages', { query: `from:<@${userId}> after:${new Date(after).toISOString().slice(0, 10)}`, count: '100', page: String(page), sort: 'timestamp', sort_dir: 'desc', highlight: 'false' }, true);
      if (!Array.isArray(data.messages?.matches)) throw new SlackApiError('invalid_response');
      for (const message of data.messages.matches.slice(0, 100)) {
        const key = `${message.channel?.id}:${message.ts}`;
        if (message.user !== userId || message.bot_id || message.subtype || typeof message.text !== 'string' || typeof message.channel?.id !== 'string'
          || !Number.isFinite(Number(message.ts)) || Number(message.ts) * 1000 < after || Number(message.ts) * 1000 > now || excluded.has(key) || seen.has(key)) continue;
        seen.add(key);
        const text = message.text.trim();
        if (text && characters < 80_000) { const sample = text.slice(0, Math.min(2000, 80_000 - characters)); texts.push(sample); characters += sample.length; }
      }
      if (data.messages.matches.length < 100) break;
    }
    return texts;
  }

  /** Only explicit user mentions of the given IDs and web links stay live; everything else, including broadcasts, is escaped. */
  /** A `note` is shown under the reply as Slack's small grey context line. */
  async reply(channel: string, threadTs: string, text: string, mentionable: string[] = [], note?: string): Promise<{ ts: string }> {
    if (!text.trim() || text.length > 12_000) throw new SlackApiError('invalid_reply');
    // With mrkdwn off Slack shows bare URLs as text, so web links are sent in explicit <url> link syntax.
    const escape = (part: string) => part.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    // A note needs blocks, so the same reply is also built as rich text: literal text, allowed mentions and links.
    const elements: Record<string, string>[] = [];
    const escaped = text.split(/(https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/).map((part, index) => {
      if (index % 2 === 0) {
        part.split(/(<@[UW][A-Z0-9]+>)/).forEach((piece, at) => {
          if (at % 2 && mentionable.includes(piece.slice(2, -1))) elements.push({ type: 'user', user_id: piece.slice(2, -1) });
          else if (piece) elements.push({ type: 'text', text: piece });
        });
        return escape(part).replace(/&lt;@([UW][A-Z0-9]+)&gt;/g, (match, id: string) => mentionable.includes(id) ? `<@${id}>` : match);
      }
      let url = part.replace(/[.,;:!?'"]+$/, '');
      while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1);
      elements.push({ type: 'link', url });
      if (part.length > url.length) elements.push({ type: 'text', text: part.slice(url.length) });
      return `<${escape(url)}>${escape(part.slice(url.length))}`;
    }).join('');
    const blocks = note ? JSON.stringify([
      { type: 'rich_text', elements: [{ type: 'rich_text_section', elements }] },
      { type: 'context', elements: [{ type: 'plain_text', text: note, emoji: false }] },
    ]) : undefined;
    const data = await this.call('chat.postMessage', {
      channel, thread_ts: threadTs, text: escaped, ...(blocks ? { blocks } : {}),
      mrkdwn: 'false', parse: 'none', link_names: 'false', reply_broadcast: 'false', unfurl_links: 'false', unfurl_media: 'false',
    }, false);
    if (typeof data.ts !== 'string') throw new SlackApiError('invalid_response');
    return { ts: data.ts };
  }

  /** Idempotent: an existing or already-removed reaction counts as done. */
  async react(channel: string, ts: string, name: string, action: 'add' | 'remove'): Promise<void> {
    try { await this.call(action === 'add' ? 'reactions.add' : 'reactions.remove', { channel, timestamp: ts, name }, false); }
    catch (error) { if (!(error instanceof SlackApiError && error.code === (action === 'add' ? 'already_reacted' : 'no_reaction'))) throw error; }
  }

  async openSocketUrl(appToken: string): Promise<string> {
    const data = await this.call('apps.connections.open', {}, true, appToken);
    try {
      const url = new URL(data.url);
      if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com')) throw new Error();
      return url.toString();
    } catch { throw new SlackApiError('invalid_socket_url'); }
  }
}
