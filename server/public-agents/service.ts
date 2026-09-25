import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PUBLIC_AGENT_PASSWORD_MIN, PUBLIC_MESSAGE_MAX, PUBLIC_SLUG, PublicAgentInputSchema, type PublicAgent, type PublicAgentInput, type PublicAgentOverview, type PublicConversationSummary,
  type PublicConversationView, type PublicMessage, type PublicRequest, type PublicRequestView, type PublicVisitorState,
} from '../../shared/public-agents.js';
import type { Run, RunOrigin } from '../../shared/types.js';
import { runAutoPromptModel } from '../auto-prompt/native.js';
import { requestedEffort, requestedModel } from '../providers/models.js';
import type { RunManager } from '../runs/manager.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';
import type { SlackProjection } from '../triggers/service.js';
import {
  COMPACT_SCHEMA, INTAKE_SCHEMA, RESULT_SCHEMA, REVIEW_SCHEMA, SUMMARY_MARK, compactSystemPrompt, intakeSystemPrompt, resultSystemPrompt, reviewSystemPrompt, workPrompt,
} from './prompts.js';

/** Trigger IDs of public agents' runs; the launch gate and the trigger list tell them apart by this prefix. */
export const PUBLIC_TRIGGER_PREFIX = 'public:';
/** The intake agent's context budget in tokens; its conversation is compacted at half of it. */
export const CONTEXT_TOKENS = 100_000;
const COMPACT_AT_PERCENT = 50;
/** Messages kept word for word after compacting. */
const KEEP_AFTER_COMPACT = 10;
const MAX_ACTIVE_MESSAGES = 200;
const MAX_STORED_MESSAGES = 300;
const MAX_AGENTS = 50;
const MAX_CONVERSATIONS = 200;
const MAX_REQUESTS = 300;
const MAX_VISITORS = 2000;
const MAX_DATA_BYTES = 8_000_000;
const VISITOR_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
/** Model calls in progress across all public agents; the rest wait for the next tick. */
const MAX_MODEL_CALLS = 4;
const MAX_RUNNING_PER_AGENT = 2;
const MAX_REQUESTS_PER_HOUR = 20;
const MAX_VISITOR_MESSAGES_PER_HOUR = 40;
const MAX_AGENT_MESSAGES_PER_HOUR = 400;
const MAX_NEW_VISITORS_PER_HOUR = 30;
const LOGIN_FAILURES = 5;
const LOGIN_WINDOW = 15 * 60 * 1000;
const AGENT_LOGIN_FAILURES = 50;
const MODEL_TIMEOUT = 180_000;
const KDF = { N: 16384, r: 8, p: 1 };
const FINISHED = new Set<Run['status']>(['completed', 'error', 'cancelled']);
const DONE = new Set<PublicRequest['status']>(['rejected', 'completed', 'failed']);

interface StoredAgent extends PublicAgentInput {
  id: string;
  slug: string;
  password?: { salt: string; hash: string };
  createdAt: string;
  updatedAt: string;
}
interface Conversation {
  id: string;
  agentId: string;
  mode: 'shared' | 'visitor';
  messages: PublicMessage[];
  /** Messages before this index are represented by `summary`. */
  activeFrom: number;
  summary?: string;
  compactedAt?: string;
  /** Visitor messages or finished requests wait for an answer. */
  needsTurn: boolean;
  /** Requests whose outcome the agent has not told the visitor about yet. */
  events: string[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}
interface StoredRequest extends PublicRequest {
  /** What the project agent said for visitors, before review; never shown as it is. */
  candidate?: string;
  succeeded?: boolean;
}
interface Visitor { hash: string; conversationId?: string; authorized: boolean; tag: string; createdAt: string; seenAt: string }
interface AgentData { version: 1; conversations: Conversation[]; requests: StoredRequest[]; visitors: Visitor[] }

export interface PublicAgentOptions {
  stateDir: string;
  runs: Pick<RunManager, 'create' | 'list'>;
  model?: typeof runAutoPromptModel;
  now?: () => number;
  tickMs?: number;
}
export interface VisitInput { token?: string; ip: string; password?: unknown; text?: unknown }
export interface VisitResult { state: PublicVisitorState; token?: string }

/** Errors a visitor's page reads by code; nothing about this Tower is in them. */
const refuse = (code: string, statusCode: number) => Object.assign(new Error(code), { statusCode });
const invalid = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const modelFor = (provider: 'claude' | 'codex') => provider === 'claude' ? 'opus' : 'gpt-5.6-sol';
const tokens = (text: string) => Math.ceil(Buffer.byteLength(text) / 3);
const newSlug = () => randomBytes(16).toString('base64url').slice(0, 22);
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64, KDF, (error, key) => error ? reject(error) : resolve(key)));
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Public agents live in the execution worker: their model calls and the work they start continue while the web
 * process restarts. Definitions are in public-agents.json; each agent's conversations, requests and visitors are in
 * public-agents/<id>.json.
 */
export class PublicAgentService extends EventEmitter {
  private agents = new Map<string, StoredAgent>();
  private data = new Map<string, AgentData>();
  private readonly working = new Set<string>();
  private readonly writes = new Map<string, Promise<void>>();
  private pendingWrites = 0;
  private storageError?: string;
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private held = false;
  private started = false;
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly model: typeof runAutoPromptModel;

  constructor(private readonly options: PublicAgentOptions) {
    super();
    this.now = options.now ?? Date.now;
    this.model = options.model ?? runAutoPromptModel;
  }
  private get file() { return join(this.options.stateDir, 'public-agents.json'); }
  private dataFile(id: string) { return join(this.options.stateDir, 'public-agents', `${id}.json`); }
  private iso() { return new Date(this.now()).toISOString(); }

  async start(): Promise<void> {
    await mkdir(join(this.options.stateDir, 'public-agents'), { recursive: true, mode: 0o700 });
    let saved: unknown;
    try { saved = await readPrivateJson(this.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (saved !== undefined) {
      if (!record(saved) || saved.version !== 1 || !Array.isArray(saved.agents)) throw new Error('Saved public agents are invalid.');
      for (const value of saved.agents as StoredAgent[]) {
        const parsed = PublicAgentInputSchema.safeParse(Object.fromEntries(Object.entries(value).filter(([key]) => !['id', 'slug', 'password', 'createdAt', 'updatedAt'].includes(key))));
        if (!parsed.success || typeof value.id !== 'string' || !PUBLIC_SLUG.test(value.slug)) throw new Error('Saved public agents are invalid.');
        this.agents.set(value.id, { ...parsed.data, id: value.id, slug: value.slug, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.password ? { password: value.password } : {}) });
      }
    }
    for (const id of this.agents.keys()) {
      let stored: unknown;
      try { stored = await readPrivateJson(this.dataFile(id)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const data: AgentData = record(stored) && stored.version === 1 && Array.isArray(stored.conversations) && Array.isArray(stored.requests) && Array.isArray(stored.visitors)
        ? stored as unknown as AgentData : { version: 1, conversations: [], requests: [], visitors: [] };
      this.recover(data);
      this.data.set(id, data);
    }
    this.started = true;
    this.resume();
  }

  /** Work cut off by a stop: a start that may have happened is matched to the run registry, never started twice. */
  private recover(data: AgentData): void {
    const runs = this.options.runs.list();
    for (const request of data.requests) {
      if (request.status !== 'dispatching') continue;
      const run = runs.find(item => item.autoPromptId === request.id);
      if (run) Object.assign(request, { status: 'running', runId: run.id, sessionId: run.sessionId });
      else this.finish(data, request, { status: 'failed', error: 'Tower stopped while starting this work. It was not started again.' });
    }
  }

  pause(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  resume(): void {
    this.pause();
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, this.options.tickMs ?? 1000);
    this.timer.unref();
  }
  close(): void { this.pause(); }
  /** No new model call or run starts; what visitors send is still saved for the next worker. */
  hold(): void { this.held = true; }
  inFlight(): boolean { return this.working.size > 0 || this.pendingWrites > 0 || Boolean(this.ticking); }
  hasActive(): boolean {
    return [...this.data.values()].some(data => data.conversations.some(item => item.needsTurn || item.events.length) || data.requests.some(item => !DONE.has(item.status)));
  }
  async flush(): Promise<void> { await Promise.allSettled([...this.writes.values()]); }

  /** Whether a public agent's run may still start: the agent exists and is on. */
  launchAllowed(agentId: string): boolean { return this.agents.get(agentId)?.enabled === true; }

  // ---- Owner --------------------------------------------------------------------------------------

  private publicAgent(agent: StoredAgent): PublicAgent {
    const { password, ...rest } = agent;
    return { ...structuredClone(rest), passwordSet: Boolean(password) };
  }
  overview(): Omit<PublicAgentOverview, 'listener'> {
    return { agents: [...this.agents.values()].map(agent => {
      const data = this.data.get(agent.id)!;
      return { ...this.publicAgent(agent),
        conversations: [...data.conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 50).map(item => this.summaryOf(item)),
        requests: data.requests.slice(-50).reverse().map(({ candidate: _candidate, succeeded: _succeeded, ...request }) => structuredClone(request)) };
    }), ...(this.storageError ? { storageError: this.storageError } : {}) };
  }
  /** Rows for the trigger list. */
  projection(): SlackProjection[] {
    return [...this.agents.values()].map(agent => ({ id: `${PUBLIC_TRIGGER_PREFIX}${agent.id}`, name: agent.name, enabled: agent.enabled, updatedAt: agent.updatedAt }));
  }
  /** A conversation as the owner reads it. */
  conversation(agentId: string, conversationId: string): PublicConversationView {
    const data = this.data.get(agentId);
    const conversation = data?.conversations.find(item => item.id === conversationId);
    if (!data || !conversation) throw invalid('대화를 찾을 수 없습니다.', 404);
    return this.view(data, conversation, MAX_STORED_MESSAGES);
  }

  async mutate(action: string, body: Record<string, unknown>): Promise<Omit<PublicAgentOverview, 'listener'>> {
    if (!record(body)) throw invalid('요청 형식이 올바르지 않습니다.');
    const agentOf = () => {
      const agent = typeof body.id === 'string' ? this.agents.get(body.id) : undefined;
      if (!agent) throw invalid('공개 에이전트를 찾을 수 없습니다.', 404);
      return agent;
    };
    if (action === 'create' || action === 'update') {
      const parsed = PublicAgentInputSchema.safeParse(body.agent);
      if (!parsed.success) throw invalid(`공개 에이전트 설정이 올바르지 않습니다: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'agent'}: ${issue.message}`).join('; ')}`);
      const input = parsed.data;
      requestedModel(input.model); requestedEffort(input.effort, input.provider);
      if (!(await stat(input.cwd).then(info => info.isDirectory(), () => false))) throw invalid(`폴더 ${input.cwd}이(가) 없습니다. 공개 에이전트는 있는 폴더에서만 작업합니다.`);
      if (action === 'create') {
        if (this.agents.size >= MAX_AGENTS) throw invalid(`공개 에이전트는 ${MAX_AGENTS}개까지 만들 수 있습니다.`);
        const at = this.iso();
        const agent: StoredAgent = { ...input, id: randomUUID(), slug: newSlug(), createdAt: at, updatedAt: at };
        if (body.password !== undefined) agent.password = await this.hashPassword(body.password);
        this.agents.set(agent.id, agent);
        this.data.set(agent.id, { version: 1, conversations: [], requests: [], visitors: [] });
        await this.saveAgents(); await this.saveData(agent.id);
      } else {
        const agent = agentOf();
        const modeChanged = agent.conversation !== input.conversation;
        Object.assign(agent, input, { updatedAt: this.iso() });
        // Conversations of one mode never show up in the other.
        if (modeChanged) { const data = this.data.get(agent.id)!; for (const visitor of data.visitors) delete visitor.conversationId; await this.saveData(agent.id); }
        await this.saveAgents();
      }
    } else if (action === 'password') {
      const agent = agentOf();
      if (body.password === null) delete agent.password;
      else agent.password = await this.hashPassword(body.password);
      agent.updatedAt = this.iso();
      // A new or removed password signs everyone out.
      const data = this.data.get(agent.id)!;
      for (const visitor of data.visitors) visitor.authorized = false;
      await this.saveAgents(); await this.saveData(agent.id);
    } else if (action === 'rotate') {
      // A new address: the old one stops working, and so do visitors' sign-ins.
      const agent = agentOf();
      agent.slug = newSlug(); agent.updatedAt = this.iso();
      this.data.get(agent.id)!.visitors = [];
      await this.saveAgents(); await this.saveData(agent.id);
    } else if (action === 'delete') {
      const agent = agentOf();
      this.agents.delete(agent.id);
      this.data.delete(agent.id);
      await this.saveAgents();
      await this.queueWrite(this.dataFile(agent.id), () => rm(this.dataFile(agent.id), { force: true }));
    } else if (action === 'reset' || action === 'delete-conversation') {
      const agent = agentOf();
      const data = this.data.get(agent.id)!;
      const conversation = data.conversations.find(item => item.id === body.conversationId);
      if (!conversation) throw invalid('대화를 찾을 수 없습니다.', 404);
      data.conversations = data.conversations.filter(item => item !== conversation);
      for (const visitor of data.visitors) if (visitor.conversationId === conversation.id) delete visitor.conversationId;
      await this.saveData(agent.id);
    } else throw invalid('지원하지 않는 공개 에이전트 요청입니다.');
    this.emit('change');
    return this.overview();
  }

  private async hashPassword(value: unknown): Promise<{ salt: string; hash: string }> {
    if (typeof value !== 'string' || value.length < PUBLIC_AGENT_PASSWORD_MIN || value.length > 256) throw invalid(`비밀번호는 ${PUBLIC_AGENT_PASSWORD_MIN}자 이상 256자 이하로 정하세요.`);
    const salt = randomBytes(16).toString('hex');
    return { salt, hash: (await derive(value, salt)).toString('hex') };
  }

  // ---- Visitors -----------------------------------------------------------------------------------

  /**
   * One request from a visitor's page. The slug names the agent; the token (from the page's cookie) names the
   * visitor. A missing or unknown token gets a new one. Turned-off and unknown agents read the same: not found.
   */
  async visit(action: 'state' | 'login' | 'message' | 'reset', slug: string, input: VisitInput): Promise<VisitResult> {
    const agent = PUBLIC_SLUG.test(slug) ? [...this.agents.values()].find(item => item.slug === slug) : undefined;
    if (!agent || !agent.enabled) throw refuse('not_found', 404);
    const data = this.data.get(agent.id)!;
    const now = this.now();
    let token: string | undefined;
    let visitor = typeof input.token === 'string' && /^[a-f\d]{64}$/.test(input.token) ? data.visitors.find(item => item.hash === sha(input.token!)) : undefined;
    if (visitor && now - Date.parse(visitor.seenAt) > VISITOR_IDLE_MS) { data.visitors = data.visitors.filter(item => item !== visitor); visitor = undefined; }
    if (!visitor) {
      if (!this.allow(`new ${input.ip}`, MAX_NEW_VISITORS_PER_HOUR, HOUR)) throw refuse('rate_limited', 429);
      token = randomBytes(32).toString('hex');
      visitor = { hash: sha(token), authorized: false, tag: sha(`${agent.id} ${token}`).slice(0, 4).toUpperCase(), createdAt: this.iso(), seenAt: this.iso() };
      data.visitors.push(visitor);
      if (data.visitors.length > MAX_VISITORS) data.visitors = [...data.visitors].sort((a, b) => b.seenAt.localeCompare(a.seenAt)).slice(0, MAX_VISITORS);
    }
    visitor.seenAt = this.iso();
    const open = () => !agent.password || visitor!.authorized;
    if (action === 'login') {
      if (!agent.password) return { state: this.stateFor(agent, data, visitor), ...(token ? { token } : {}) };
      if (this.count(`fail ${agent.id} ${input.ip}`, LOGIN_WINDOW) >= LOGIN_FAILURES || this.count(`fail ${agent.id}`, HOUR) >= AGENT_LOGIN_FAILURES) throw refuse('login_blocked', 429);
      const supplied = typeof input.password === 'string' && input.password.length <= 256 ? input.password : '';
      const expected = Buffer.from(agent.password.hash, 'hex');
      const actual = await derive(supplied, agent.password.salt);
      if (!supplied || !timingSafeEqual(actual, expected)) {
        this.allow(`fail ${agent.id} ${input.ip}`, Infinity, LOGIN_WINDOW); this.allow(`fail ${agent.id}`, Infinity, HOUR);
        await this.saveData(agent.id);
        throw refuse('wrong_password', 401);
      }
      // A fresh token after signing in, so a token handed out before cannot ride on this sign-in.
      token = randomBytes(32).toString('hex');
      data.visitors = data.visitors.filter(item => item !== visitor);
      visitor = { ...visitor, hash: sha(token), authorized: true };
      data.visitors.push(visitor);
    } else if (action === 'message') {
      if (!open()) throw refuse('password_required', 401);
      const text = typeof input.text === 'string' ? input.text.trim() : '';
      if (!text || text.length > PUBLIC_MESSAGE_MAX) throw refuse('invalid_message', 400);
      if (this.count(`message ${visitor.hash}`, HOUR) >= MAX_VISITOR_MESSAGES_PER_HOUR || this.count(`message ${agent.id}`, HOUR) >= MAX_AGENT_MESSAGES_PER_HOUR) throw refuse('rate_limited', 429);
      this.allow(`message ${visitor.hash}`, Infinity, HOUR); this.allow(`message ${agent.id}`, Infinity, HOUR);
      const conversation = this.conversationFor(agent, data, visitor, true)!;
      conversation.messages.push({ id: randomUUID(), role: 'visitor', text, at: this.iso(), ...(agent.conversation === 'shared' ? { visitor: visitor.tag } : {}) });
      conversation.needsTurn = true;
      delete conversation.error;
      conversation.updatedAt = this.iso();
      this.trim(conversation);
      void this.tick().catch(() => {});
    } else if (action === 'reset') {
      if (!open()) throw refuse('password_required', 401);
      if (agent.conversation !== 'visitor') throw refuse('reset_unavailable', 403);
      const current = data.conversations.find(item => item.id === visitor!.conversationId);
      if (current) data.conversations = data.conversations.filter(item => item !== current);
      delete visitor.conversationId;
    }
    // Polling only moves the last-seen time, which is saved with the next real change.
    if (action !== 'state' || token) await this.saveData(agent.id);
    if (action !== 'state') this.emit('change');
    return { state: this.stateFor(agent, data, visitor), ...(token ? { token } : {}) };
  }

  private stateFor(agent: StoredAgent, data: AgentData, visitor: Visitor): PublicVisitorState {
    const access = !agent.password || visitor.authorized ? 'open' : 'password';
    const conversation = access === 'open' ? this.conversationFor(agent, data, visitor, false) : undefined;
    return {
      agent: { name: agent.name, description: agent.description, conversation: agent.conversation, passwordRequired: Boolean(agent.password) },
      access,
      ...(access === 'open' ? { conversation: conversation ? this.view(data, conversation, 100, true)
        : { id: '', messages: [], requests: [], busy: false, contextPercent: 0 } } : {}),
      canReset: access === 'open' && agent.conversation === 'visitor',
    };
  }

  private conversationFor(agent: StoredAgent, data: AgentData, visitor: Visitor, create: boolean): Conversation | undefined {
    const found = agent.conversation === 'shared'
      ? data.conversations.find(item => item.mode === 'shared')
      : data.conversations.find(item => item.mode === 'visitor' && item.id === visitor.conversationId);
    if (found || !create) return found;
    const at = this.iso();
    const conversation: Conversation = { id: randomUUID(), agentId: agent.id, mode: agent.conversation, messages: [], activeFrom: 0, needsTurn: false, events: [], createdAt: at, updatedAt: at };
    data.conversations.push(conversation);
    if (agent.conversation === 'visitor') visitor.conversationId = conversation.id;
    if (data.conversations.length > MAX_CONVERSATIONS) {
      const keep = new Set(data.conversations.filter(item => item.needsTurn || item.events.length || data.requests.some(request => request.conversationId === item.id && !DONE.has(request.status))).map(item => item.id));
      const removable = data.conversations.filter(item => !keep.has(item.id) && item !== conversation).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      const drop = new Set(removable.slice(0, data.conversations.length - MAX_CONVERSATIONS).map(item => item.id));
      data.conversations = data.conversations.filter(item => !drop.has(item.id));
    }
    return conversation;
  }

  private view(data: AgentData, conversation: Conversation, limit: number, forVisitor = false): PublicConversationView {
    const requests = data.requests.filter(item => item.conversationId === conversation.id).slice(-20).reverse()
      .map(({ id, request, status, createdAt, updatedAt, reason, result }): PublicRequestView => ({ id, request, status, createdAt, updatedAt, ...(reason ? { reason } : {}), ...(result ? { result } : {}) }));
    const messages = conversation.messages.slice(-limit).map(message => forVisitor && conversation.mode === 'visitor' ? (({ visitor: _tag, ...rest }) => rest)(message) : { ...message });
    return { id: conversation.id, messages, requests, busy: conversation.needsTurn || this.working.has(`turn:${conversation.id}`),
      contextPercent: this.contextPercent(conversation), ...(conversation.compactedAt ? { compactedAt: conversation.compactedAt } : {}) };
  }

  private summaryOf(conversation: Conversation): PublicConversationSummary {
    const last = conversation.messages.at(-1);
    return { id: conversation.id, mode: conversation.mode, messageCount: conversation.messages.length, ...(last ? { lastMessage: last.text.slice(0, 200) } : {}), updatedAt: conversation.updatedAt,
      busy: conversation.needsTurn || this.working.has(`turn:${conversation.id}`), contextPercent: this.contextPercent(conversation), ...(conversation.error ? { error: conversation.error } : {}) };
  }

  private contextPercent(conversation: Conversation): number {
    const used = tokens(conversation.summary ?? '') + conversation.messages.slice(conversation.activeFrom).reduce((sum, message) => sum + tokens(message.text) + 20, 0);
    return Math.min(100, Math.round(used / CONTEXT_TOKENS * 100));
  }

  // ---- Work ---------------------------------------------------------------------------------------

  tick(): Promise<void> {
    if (!this.started) return Promise.resolve();
    return this.ticking ??= this.step().finally(() => { this.ticking = undefined; });
  }

  private async step(): Promise<void> {
    const runs = this.options.runs.list();
    for (const [agentId, data] of this.data) {
      const agent = this.agents.get(agentId);
      if (!agent) continue;
      for (const request of data.requests) {
        if (request.status === 'running') this.track(agent, data, request, runs);
        if (this.held) continue;
        if (request.status === 'reviewing') this.launch(`review:${request.id}`, () => this.review(agent, data, request));
        else if (request.status === 'summarizing') this.launch(`summary:${request.id}`, () => this.summarize(agent, data, request));
        else if (request.status === 'queued' && data.requests.filter(item => item.status === 'running' || item.status === 'dispatching').length < MAX_RUNNING_PER_AGENT) {
          await this.dispatch(agent, data, request);
        }
      }
      if (this.held) continue;
      for (const conversation of data.conversations) {
        // A request still being checked is reported together with its outcome, not before.
        if (conversation.needsTurn || conversation.events.some(id => DONE.has(data.requests.find(item => item.id === id)?.status ?? 'failed'))) this.launch(`turn:${conversation.id}`, () => this.turn(agent, data, conversation));
      }
    }
  }

  /** Starts one model call unless it is already going or too many are. */
  private launch(key: string, work: () => Promise<void>): void {
    if (this.working.has(key) || [...this.working].filter(item => !item.startsWith('dispatch:')).length >= MAX_MODEL_CALLS) return;
    this.working.add(key);
    this.emit('change');
    void work().catch(() => {}).finally(() => { this.working.delete(key); this.emit('change'); });
  }

  private alive(agent: StoredAgent, data: AgentData): boolean { return this.agents.get(agent.id) === agent && this.data.get(agent.id) === data; }

  private async turn(agent: StoredAgent, data: AgentData, conversation: Conversation): Promise<void> {
    const reported = conversation.events.filter(id => DONE.has(data.requests.find(item => item.id === id)?.status ?? 'failed'));
    try {
      if (this.contextPercent(conversation) >= COMPACT_AT_PERCENT || conversation.messages.length - conversation.activeFrom > MAX_ACTIVE_MESSAGES) await this.compact(agent, conversation);
      const seen = conversation.messages.length;
      const requests = data.requests.filter(item => item.conversationId === conversation.id).slice(-20)
        .map(({ id, request, status, reason, result }) => ({ id, request, status, ...(reason ? { reason } : {}), ...(result ? { result } : {}) }));
      const prompt = JSON.stringify({
        ...(conversation.summary ? { earlierConversationSummary: conversation.summary } : {}),
        messages: conversation.messages.slice(conversation.activeFrom).map(({ role, text, visitor, at }) => ({ from: role === 'agent' ? 'you' : role === 'visitor' ? `visitor${visitor ? ` ${visitor}` : ''}` : 'tower', text, at })),
        requests,
        ...(reported.length ? { justFinished: reported } : {}),
      });
      const answer = await this.model({ provider: agent.intakeProvider, model: modelFor(agent.intakeProvider), systemPrompt: intakeSystemPrompt(agent), prompt, schema: INTAKE_SCHEMA,
        signal: AbortSignal.timeout(MODEL_TIMEOUT) }, { stateDir: this.options.stateDir }) as { reply?: unknown; submitRequest?: unknown };
      if (!this.alive(agent, data) || !data.conversations.includes(conversation)) return;
      const reply = typeof answer?.reply === 'string' ? answer.reply.trim().slice(0, 8000) : '';
      const submitted = typeof answer?.submitRequest === 'string' ? answer.submitRequest.trim().slice(0, 8000) : '';
      if (!reply) throw new Error('The agent returned no reply.');
      conversation.messages.push({ id: randomUUID(), role: 'agent', text: reply, at: this.iso() });
      // Visitors who wrote while the agent answered get the next turn.
      conversation.needsTurn = conversation.messages.slice(seen).some(message => message.role === 'visitor');
      conversation.events = conversation.events.filter(id => !reported.includes(id));
      delete conversation.error;
      conversation.updatedAt = this.iso();
      if (submitted) this.submit(agent, data, conversation, submitted);
      this.trim(conversation);
    } catch {
      if (!this.alive(agent, data) || !data.conversations.includes(conversation)) return;
      // Never retried on its own, so a failing model is not called in a loop; the next message tries again. The
      // outcomes it could not explain stay visible on their request cards.
      conversation.needsTurn = false;
      conversation.events = conversation.events.filter(id => !reported.includes(id));
      conversation.error = 'The agent could not answer. Send your message again in a moment.';
      conversation.updatedAt = this.iso();
    }
    await this.saveData(agent.id);
  }

  private async compact(agent: StoredAgent, conversation: Conversation): Promise<void> {
    const until = Math.max(conversation.activeFrom, conversation.messages.length - KEEP_AFTER_COMPACT);
    if (until <= conversation.activeFrom) return;
    const folded = conversation.messages.slice(conversation.activeFrom, until).map(({ role, text, visitor }) => ({ from: role === 'agent' ? 'agent' : role === 'visitor' ? `visitor${visitor ? ` ${visitor}` : ''}` : 'tower', text }));
    const answer = await this.model({ provider: agent.intakeProvider, model: modelFor(agent.intakeProvider), systemPrompt: compactSystemPrompt(),
      prompt: JSON.stringify({ previousSummary: conversation.summary ?? '', messages: folded }), schema: COMPACT_SCHEMA, signal: AbortSignal.timeout(MODEL_TIMEOUT) }, { stateDir: this.options.stateDir }) as { summary?: unknown };
    if (typeof answer?.summary !== 'string' || !answer.summary.trim()) throw new Error('Compaction returned no summary.');
    conversation.summary = answer.summary.trim().slice(0, 6000);
    conversation.activeFrom = until;
    conversation.compactedAt = this.iso();
  }

  /** Keeps stored history bounded; only messages already folded into the summary are dropped. */
  private trim(conversation: Conversation): void {
    const extra = conversation.messages.length - MAX_STORED_MESSAGES;
    if (extra <= 0) return;
    const drop = Math.min(extra, conversation.activeFrom);
    conversation.messages = conversation.messages.slice(drop);
    conversation.activeFrom -= drop;
  }

  private submit(agent: StoredAgent, data: AgentData, conversation: Conversation, text: string): void {
    const at = this.iso();
    const request: StoredRequest = { id: randomUUID(), agentId: agent.id, conversationId: conversation.id, request: text, status: 'reviewing', createdAt: at, updatedAt: at };
    data.requests.push(request);
    conversation.events.push(request.id);
    if (this.count(`request ${agent.id}`, HOUR) >= MAX_REQUESTS_PER_HOUR) {
      this.finish(data, request, { status: 'rejected', reason: 'Too many requests are being handled right now. Please try again later.' });
    } else this.allow(`request ${agent.id}`, Infinity, HOUR);
    if (data.requests.length > MAX_REQUESTS) {
      const drop = data.requests.filter(item => DONE.has(item.status)).slice(0, data.requests.length - MAX_REQUESTS).map(item => item.id);
      data.requests = data.requests.filter(item => !drop.includes(item.id));
    }
    void this.tick().catch(() => {});
  }

  private finish(data: AgentData, request: StoredRequest, patch: Partial<StoredRequest>): void {
    Object.assign(request, patch, { updatedAt: this.iso() });
    const conversation = data.conversations.find(item => item.id === request.conversationId);
    if (conversation && DONE.has(request.status) && !conversation.events.includes(request.id)) conversation.events.push(request.id);
  }

  private async review(agent: StoredAgent, data: AgentData, request: StoredRequest): Promise<void> {
    let patch: Partial<StoredRequest>;
    try {
      const answer = await this.model({ provider: agent.intakeProvider, model: modelFor(agent.intakeProvider), systemPrompt: reviewSystemPrompt(),
        prompt: JSON.stringify({ ownerScope: agent.scope, request: request.request }), schema: REVIEW_SCHEMA, signal: AbortSignal.timeout(MODEL_TIMEOUT) }, { stateDir: this.options.stateDir }) as { allowed?: unknown; reason?: unknown };
      const reason = typeof answer?.reason === 'string' ? answer.reason.trim().slice(0, 1000) : '';
      // Only an explicit yes lets it through.
      patch = answer?.allowed === true ? { status: 'queued' } : { status: 'rejected', reason: reason || 'This request is outside what this agent can do.' };
    } catch (error) {
      // A review that does not finish cleanly (for example a model that reaches for a tool) refuses the request.
      patch = { status: 'rejected', reason: 'This request could not be accepted as written.', error: `The review did not finish: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}` };
    }
    if (!this.alive(agent, data) || request.status !== 'reviewing') return;
    this.finish(data, request, patch);
    await this.saveData(agent.id);
    void this.tick().catch(() => {});
  }

  private async dispatch(agent: StoredAgent, data: AgentData, request: StoredRequest): Promise<void> {
    const key = `dispatch:${request.id}`;
    if (this.working.has(key)) return;
    this.working.add(key);
    try {
      if (!agent.enabled) { this.finish(data, request, { status: 'failed', error: 'The public agent was turned off before this started.', result: 'This request was not started.' }); return; }
      if (!(await stat(agent.cwd).then(info => info.isDirectory(), () => false))) { this.finish(data, request, { status: 'failed', error: `The folder ${agent.cwd} no longer exists.`, result: 'This request could not be started.' }); return; }
      // Saved before anything starts: after a stop it is matched to the run registry, never started twice.
      Object.assign(request, { status: 'dispatching', updatedAt: this.iso() });
      await this.saveData(agent.id);
      const origin: RunOrigin = { kind: 'trigger', triggerId: `${PUBLIC_TRIGGER_PREFIX}${agent.id}`, eventId: request.id };
      try {
        const { session, run } = await this.options.runs.create({ provider: agent.provider, cwd: agent.cwd, prompt: workPrompt(agent, request.request), title: `Public · ${agent.name}`.slice(0, 120),
          ...(agent.model ? { model: agent.model } : {}), ...(agent.effort ? { effort: agent.effort } : {}), ...(agent.provider === 'codex' ? { codexApprovalsReviewer: 'auto_review' as const } : {}) },
        { autoPromptId: request.id, origin, untrustedInput: true, unattended: true, createFolder: false, trustWorkspace: true });
        Object.assign(request, { status: 'running', runId: run.id, sessionId: session.id, updatedAt: this.iso() });
      } catch (error) {
        const run = this.options.runs.list().find(item => item.autoPromptId === request.id);
        if (run) Object.assign(request, { status: 'running', runId: run.id, sessionId: run.sessionId, updatedAt: this.iso() });
        else this.finish(data, request, { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 1000), result: 'This request could not be started.' });
      }
    } finally {
      this.working.delete(key);
      if (this.alive(agent, data)) await this.saveData(agent.id);
      this.emit('change');
    }
  }

  private track(agent: StoredAgent, data: AgentData, request: StoredRequest, runs: Run[]): void {
    const run = runs.find(item => item.id === request.runId) ?? runs.find(item => item.autoPromptId === request.id);
    if (!run) { this.finish(data, request, { status: 'failed', error: 'The run record is no longer available.', result: 'The outcome of this request could not be confirmed.' }); void this.saveData(agent.id); return; }
    if (!FINISHED.has(run.status)) return;
    const output = run.output ?? '';
    const mark = output.lastIndexOf(SUMMARY_MARK);
    const candidate = (mark >= 0 ? output.slice(mark + SUMMARY_MARK.length) : output.slice(-3000)).trim().slice(0, 6000);
    Object.assign(request, { status: 'summarizing', candidate, succeeded: run.status === 'completed', updatedAt: this.iso(),
      ...(run.status !== 'completed' ? { error: (run.error ?? `The run ended as ${run.status}.`).slice(0, 1000) } : {}) });
    void this.saveData(agent.id);
  }

  private async summarize(agent: StoredAgent, data: AgentData, request: StoredRequest): Promise<void> {
    let text: string;
    try {
      const answer = await this.model({ provider: agent.intakeProvider, model: modelFor(agent.intakeProvider), systemPrompt: resultSystemPrompt(),
        prompt: JSON.stringify({ ownerScope: agent.scope, request: request.request, finished: request.succeeded === true, candidateSummary: request.candidate ?? '' }), schema: RESULT_SCHEMA,
        signal: AbortSignal.timeout(MODEL_TIMEOUT) }, { stateDir: this.options.stateDir }) as { text?: unknown };
      text = typeof answer?.text === 'string' ? answer.text.trim().slice(0, 6000) : '';
      if (!text) throw new Error('empty');
    } catch {
      // Without a reviewed text nothing the project agent wrote reaches the visitor.
      text = request.succeeded ? 'The request finished, but its result could not be prepared for sharing.' : 'The request could not be completed.';
    }
    if (!this.alive(agent, data) || request.status !== 'summarizing') return;
    this.finish(data, request, { status: request.succeeded ? 'completed' : 'failed', result: text, candidate: undefined });
    delete request.candidate;
    await this.saveData(agent.id);
  }

  // ---- Limits and storage -------------------------------------------------------------------------

  /** Records a hit and says whether it stayed within `limit` hits per `windowMs`. */
  private allow(key: string, limit: number, windowMs: number): boolean {
    const now = this.now();
    const hits = (this.hits.get(key) ?? []).filter(at => at > now - windowMs);
    if (hits.length >= limit) { this.hits.set(key, hits); return false; }
    hits.push(now);
    this.hits.set(key, hits);
    if (this.hits.size > 20_000) for (const [name, times] of this.hits) if (!times.some(at => at > now - HOUR)) this.hits.delete(name);
    return true;
  }
  private count(key: string, windowMs: number): number {
    const now = this.now();
    return (this.hits.get(key) ?? []).filter(at => at > now - windowMs).length;
  }

  private queueWrite(path: string, write: () => Promise<unknown>): Promise<void> {
    this.pendingWrites++;
    const work = (this.writes.get(path) ?? Promise.resolve()).catch(() => {}).then(write).then(() => { this.storageError = undefined; }, error => {
      this.storageError = `Cannot save public agents: ${error instanceof Error ? error.message : String(error)}`;
      this.emit('change');
      throw error;
    }).finally(() => { this.pendingWrites--; if (this.writes.get(path) === work) this.writes.delete(path); });
    this.writes.set(path, work);
    return work;
  }
  private saveAgents(): Promise<void> {
    return this.queueWrite(this.file, () => writePrivateJson(this.file, JSON.stringify({ version: 1, agents: [...this.agents.values()] })));
  }
  private saveData(id: string): Promise<void> {
    const data = this.data.get(id);
    if (!data) return Promise.resolve();
    return this.queueWrite(this.dataFile(id), async () => {
      // Written as it is when the write starts, so a burst of changes costs one write each, in order.
      let text = JSON.stringify(data);
      // Oldest idle conversations go first when an agent's history grows too large.
      while (Buffer.byteLength(text) > MAX_DATA_BYTES && data.conversations.length > 1) {
        const oldest = [...data.conversations].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))[0];
        data.conversations = data.conversations.filter(item => item !== oldest);
        text = JSON.stringify(data);
      }
      await writePrivateJson(this.dataFile(id), text);
    }).catch(() => {});
  }
}
