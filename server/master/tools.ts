import { randomUUID } from 'node:crypto';
import { MASTER_PANELS, type MasterDirectiveResult, type MasterFilter, type MasterPanel, type MasterScreenCommand, type MasterStreamEvent } from '../../shared/master.js';
import { NODE_ID, TOWER_TOOLS, TowerTools, truncate, type TowerToolsOptions } from '../tower-tools/tools.js';
import { apiTarget } from '../tower-tools/api-target.js';
import { masterWorkerModel, parseModelSettings } from '../../shared/models.js';

/** How long a screen command waits for the page to say it was done. */
const ACK_MS = 5_000;
/** A page that said it shows the master within this time is where screen commands go. */
const PRESENCE_MS = 2 * 60_000;

/** The tools the master session gets from Tower, besides its own and Tower's MCP operations: the Tower tools and the owner's screen. */
export const MASTER_TOOLS = [
  ...TOWER_TOOLS.filter(tool => tool.name !== 'terminal_read'),
  { name: 'ui', description: 'Do something on the owner\'s screen, in the tab showing you, with the page\'s own controls. The result says whether the page did it.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['openSession', 'close', 'openPanel', 'filter', 'setPreference'], description: 'openSession: show a conversation. close: close the open conversation. openPanel: open one of the page\'s panels. filter: set the sidebar filters. setPreference: language or chat text size.' },
      sessionId: { type: 'string' },
      node: { type: 'string', description: '32-hex id of the joined computer the session, folder or Auto Prompt is on.' },
      panel: { type: 'string', enum: [...MASTER_PANELS], description: 'sessions: the session list. newSession/autoPrompt open their dialogs (cwd, and for newSession title/prompt, prefill them).' },
      cwd: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' },
      filter: { type: 'object', additionalProperties: false, properties: {
        reset: { type: 'boolean', description: 'Clear the search and filters first.' }, query: { type: 'string' },
        provider: { type: 'string', enum: ['all', 'claude', 'codex'] }, status: { type: 'string', enum: ['all', 'working', 'idle', 'completed', 'error'] },
        period: { type: 'string', enum: ['1', '7', '30', 'all'], description: 'Days of activity shown.' },
        project: { type: 'string', description: 'A folder (cwd); on a joined computer, give computer too.' },
        computer: { type: 'string', description: '"all", "local" or a joined computer\'s id.' },
        closed: { type: 'boolean', description: 'Show closed sessions instead of open ones.' }, showHidden: { type: 'boolean', description: 'Show hidden folders on the canvas.' },
      } },
      language: { type: 'string', enum: ['ko', 'en'] },
      chatFontSize: { type: 'integer', minimum: 11, maximum: 22 },
    }, required: ['action'], additionalProperties: false } },
  ...TOWER_TOOLS.filter(tool => tool.name === 'terminal_read'),
];

export interface MasterToolsOptions extends TowerToolsOptions {
  /** Sends a screen command to the pages. */
  broadcast(event: MasterStreamEvent): void;
  ackMs?: number;
}

/**
 * What the master session's `tower_master` tools do, run here in the master host, which calls Tower like a page.
 * Nothing is limited: the master may do whatever the owner's pages can.
 */
export class MasterTools extends TowerTools {
  private readonly acks = new Map<string, (value: { result: MasterDirectiveResult; note?: string }) => void>();
  private tab?: { id: string; at: number };

  constructor(private readonly master: MasterToolsOptions) { super(master); }

  override async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === 'tower_api' && args.method === 'POST') {
      try {
        const target = apiTarget(String(args.method), String(args.path), typeof args.node === 'string' ? args.node : undefined);
        if (['/api/sessions', '/api/auto-prompts', '/api/v1/autoPrompt.submit'].includes(target.local)) {
          const body = args.body && typeof args.body === 'object' && !Array.isArray(args.body) ? args.body as Record<string, unknown> : {};
          let input: Record<string, unknown> = { ...body, modelRole: 'master.worker' };
          // Old remote create endpoints ignored unknown fields. Read the receiving worker's actual registry before
          // sending a concrete, backwards-compatible request; never infer support from client-side defaults.
          if (target.node && target.local === '/api/sessions') {
            const reply = await this.master.tower.call('POST', `/api/nodes/${target.node}/v1/models.settings`, {}, { write: false, signal: AbortSignal.timeout(30_000) });
            const settings = (reply.body as { result?: { settings?: { roles?: Record<string, unknown> } } } | undefined)?.result?.settings;
            if (reply.state !== 'succeeded' || !settings?.roles?.['master.worker']) return { error: '연결된 컴퓨터가 master.worker를 지원하지 않습니다. 업데이트 후 다시 보내세요. 아직 작업을 보내지 않았습니다.' };
            const resolved = masterWorkerModel(parseModelSettings(settings, true), body);
            const { modelRole: _role, ...explicit } = body;
            input = { ...explicit, ...resolved };
          }
          args = { ...args, body: input };
        }
      } catch (error) { return { error: (error as Error).message }; }
    }
    if (name !== 'ui') return super.call(name, args);
    if (!this.master.tower.hasCredentials()) return { error: 'Tower 웹에 아직 연결되지 않았습니다. 잠시 뒤 다시 하세요.' };
    return this.ui(args);
  }

  /** A page showing the master says so, and screen commands go to it. */
  present(tabId: string): void { this.tab = { id: tabId, at: Date.now() }; }

  /** The page's word on a screen command. */
  ack(id: string, result: MasterDirectiveResult, note?: string): boolean {
    const waiting = this.acks.get(id);
    waiting?.({ result, ...(note ? { note } : {}) });
    return Boolean(waiting);
  }

  /** A screen command in the tab showing the master, done by the page with its own controls. */
  private async ui(args: Record<string, unknown>): Promise<unknown> {
    let command: MasterScreenCommand;
    try { command = screenCommand(args); } catch (error) { return { error: (error as Error).message }; }
    const tab = this.tab && Date.now() - this.tab.at < PRESENCE_MS ? this.tab.id : undefined;
    if (!tab) return { result: 'no-page', note: 'No page of the owner shows the master now, so nothing was shown.' };
    const id = randomUUID();
    const reply = await new Promise<{ result: MasterDirectiveResult; note?: string } | undefined>(resolve => {
      const finish = (value: { result: MasterDirectiveResult; note?: string } | undefined) => { clearTimeout(timer); this.acks.delete(id); resolve(value); };
      const timer = setTimeout(() => finish(undefined), this.master.ackMs ?? ACK_MS);
      this.acks.set(id, finish);
      this.master.broadcast({ type: 'directive', seq: 0, directive: { ...command, id, tabId: tab, expiresAt: Date.now() + 30_000 } });
    });
    return reply ? { result: reply.result, ...(reply.note ? { note: truncate(reply.note, 300) } : {}) } : { result: 'no-answer', note: 'The page did not confirm; it may be closed or in the background.' };
  }

}

/** A screen command from the model's arguments, checked field by field. */
export function screenCommand(args: Record<string, unknown>): MasterScreenCommand {
  const refuse = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
  const text = (value: unknown, max: number, name: string) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > max) throw refuse(`${name}이(가) 올바르지 않습니다.`);
    return value;
  };
  const node = (value: unknown) => {
    const id = text(value, 32, 'node');
    if (id && !NODE_ID.test(id)) throw refuse('연결된 컴퓨터 ID가 올바르지 않습니다.');
    return id || undefined;
  };
  switch (args.action) {
    case 'openSession': {
      const sessionId = text(args.sessionId, 400, 'sessionId');
      if (!sessionId) throw refuse('sessionId가 필요합니다.');
      const where = node(args.node);
      return { kind: 'openSession', sessionId, ...(where ? { node: where } : {}) };
    }
    case 'close': return { kind: 'close' };
    case 'openPanel': {
      if (!(MASTER_PANELS as readonly unknown[]).includes(args.panel)) throw refuse(`panel은 ${MASTER_PANELS.join(', ')} 중 하나입니다.`);
      const cwd = text(args.cwd, 4096, 'cwd'), title = text(args.title, 200, 'title'), prompt = text(args.prompt, 8000, 'prompt'), where = node(args.node);
      return { kind: 'openPanel', panel: args.panel as MasterPanel, ...(cwd ? { cwd } : {}), ...(where ? { node: where } : {}), ...(title ? { title } : {}), ...(prompt ? { prompt } : {}) };
    }
    case 'filter': {
      const input = args.filter;
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw refuse('filter가 필요합니다.');
      const filter: MasterFilter = {};
      for (const [key, value] of Object.entries(input)) {
        const one = (allowed: readonly string[]) => { if (typeof value !== 'string' || !allowed.includes(value)) throw refuse(`${key} 값이 올바르지 않습니다.`); return value; };
        const flag = () => { if (typeof value !== 'boolean') throw refuse(`${key} 값이 올바르지 않습니다.`); return value; };
        if (key === 'reset') filter.reset = flag();
        else if (key === 'query') filter.query = text(value, 200, 'query') ?? '';
        else if (key === 'provider') filter.provider = one(['all', 'claude', 'codex']) as MasterFilter['provider'];
        else if (key === 'status') filter.status = one(['all', 'working', 'idle', 'completed', 'error']) as MasterFilter['status'];
        else if (key === 'period') filter.period = one(['1', '7', '30', 'all']) as MasterFilter['period'];
        else if (key === 'project') filter.project = text(value, 4096, 'project') ?? '';
        else if (key === 'computer') { const computer = text(value, 32, 'computer'); if (computer !== 'all' && computer !== 'local' && !NODE_ID.test(computer ?? '')) throw refuse('computer 값이 올바르지 않습니다.'); filter.computer = computer; }
        else if (key === 'closed') filter.closed = flag();
        else if (key === 'showHidden') filter.showHidden = flag();
        else throw refuse(`알 수 없는 필터: ${key}`);
      }
      return { kind: 'filter', filter };
    }
    case 'setPreference': {
      const language = args.language === undefined ? undefined : args.language === 'ko' || args.language === 'en' ? args.language : null;
      const size = args.chatFontSize === undefined ? undefined : Number.isInteger(args.chatFontSize) && (args.chatFontSize as number) >= 11 && (args.chatFontSize as number) <= 22 ? args.chatFontSize as number : null;
      if (language === null || size === null || (language === undefined && size === undefined)) throw refuse('language(ko, en) 또는 chatFontSize(11–22)를 주세요.');
      return { kind: 'preference', ...(language ? { language } : {}), ...(size !== undefined ? { chatFontSize: size } : {}) };
    }
  }
  throw refuse('action은 openSession, close, openPanel, filter, setPreference 중 하나입니다.');
}
