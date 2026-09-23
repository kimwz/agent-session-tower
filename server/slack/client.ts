import type { SlackMessage } from '../../shared/slack.js';
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

const safeErrors = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'account_inactive', 'missing_scope', 'not_in_channel', 'channel_not_found', 'thread_not_found', 'ratelimited', 'is_archived', 'restricted_action', 'invalid_name', 'too_many_reactions', 'message_not_found', 'already_reacted', 'no_reaction']);

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
        // Bound responses before JSON parsing, including chunked bodies.
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2_000_000) { await reader.cancel(); throw new Error(); }
          chunks.push(value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
        if (typeof message.ts !== 'string' || typeof message.text !== 'string') throw new SlackApiError('invalid_response');
        totalCharacters += message.text.length;
        messages.push({ ts: message.ts, text: message.text, user: typeof message.user === 'string' ? message.user : typeof message.bot_id === 'string' ? message.bot_id : 'unknown' });
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

  /** Only explicit user mentions of the given IDs stay live; everything else, including broadcasts, is escaped. */
  async reply(channel: string, threadTs: string, text: string, mentionable: string[] = []): Promise<{ ts: string }> {
    if (!text.trim() || text.length > 12_000) throw new SlackApiError('invalid_reply');
    const escaped = text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replace(/&lt;@([UW][A-Z0-9]+)&gt;/g, (match, id: string) => mentionable.includes(id) ? `<@${id}>` : match);
    const data = await this.call('chat.postMessage', {
      channel, thread_ts: threadTs, text: escaped,
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
