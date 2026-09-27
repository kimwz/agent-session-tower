import { randomUUID } from 'node:crypto';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MasterDraft, MasterEntry, MasterEntryData, MasterStreamEvent } from '../../shared/master.js';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

const SEGMENT = 500;
const BUFFERED = 2000;
const segmentName = (index: number) => `${String(index).padStart(6, '0')}.json`;

/**
 * The master's one conversation. Entries are saved in files of 500 by creation order; a changed entry (an action
 * that finished, a task that ended) replaces itself in its file. Live changes carry `(epoch, seq)`: the epoch is this
 * host's run, so a page that reconnects to another run starts again from a checkpoint instead of guessing.
 */
export class MasterRoom {
  readonly epoch = randomUUID();
  private seq = 0;
  private nextOrder = 0;
  private readonly loaded = new Map<number, MasterEntry[]>();
  private readonly byId = new Map<string, MasterEntry>();
  private readonly buffer: MasterStreamEvent[] = [];
  private readonly listeners = new Set<(event: MasterStreamEvent) => void>();
  private writes: Promise<void> = Promise.resolve();
  private draft: MasterDraft | null = null;
  private readonly directory: string;

  constructor(dataDirectory: string) { this.directory = join(dataDirectory, 'room'); }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.directory)).filter(name => /^\d{6}\.json$/.test(name)).sort();
    const last = names.at(-1);
    if (!last) return;
    const index = Number(last.slice(0, 6));
    const entries = await this.segment(index);
    this.nextOrder = entries.length ? entries.at(-1)!.order + 1 : index * SEGMENT;
    if (index > 0) await this.segment(index - 1);
  }

  /** Adds an entry and returns it. */
  add(data: MasterEntryData, id: string = randomUUID()): MasterEntry {
    const entry: MasterEntry = { id, order: this.nextOrder++, at: new Date().toISOString(), revision: 1, data };
    const index = Math.floor(entry.order / SEGMENT);
    const list = this.loaded.get(index) ?? [];
    this.loaded.set(index, list);
    list.push(entry);
    this.byId.set(entry.id, entry);
    this.persist(index);
    this.emit({ type: 'entry', seq: 0, entry });
    return entry;
  }

  /** Replaces a known entry's data; entries no longer in memory are left as they were. */
  update(id: string, data: MasterEntryData): MasterEntry | undefined {
    const current = this.byId.get(id);
    if (!current) return undefined;
    const entry: MasterEntry = { ...current, revision: current.revision + 1, data };
    const index = Math.floor(entry.order / SEGMENT);
    const list = this.loaded.get(index);
    if (!list) return undefined;
    const position = list.findIndex(item => item.id === id);
    if (position < 0) return undefined;
    list[position] = entry;
    this.byId.set(id, entry);
    this.persist(index);
    this.emit({ type: 'entry', seq: 0, entry });
    return entry;
  }

  get(id: string): MasterEntry | undefined { return this.byId.get(id); }

  setDraft(draft: MasterDraft | null): void {
    this.draft = draft;
    this.emit({ type: 'draft', seq: 0, draft });
  }
  currentDraft(): MasterDraft | undefined { return this.draft ?? undefined; }

  /** Anything else the page should hear live (overview changes, screen directives). */
  broadcast(event: MasterStreamEvent): void { this.emit(event); }

  /** Entries before `before` (creation order), newest last; at most `limit`. */
  async page(before = Number.MAX_SAFE_INTEGER, limit = 100): Promise<{ entries: MasterEntry[]; hasMore: boolean }> {
    const size = Math.min(Math.max(limit, 1), 200);
    const end = Math.min(before, this.nextOrder);
    const collected: MasterEntry[] = [];
    let index = Math.floor((end - 1) / SEGMENT);
    while (index >= 0 && collected.length < size) {
      const entries = (await this.segment(index)).filter(entry => entry.order < end);
      collected.unshift(...entries.slice(-(size - collected.length)));
      index--;
    }
    const first = collected[0]?.order ?? 0;
    return { entries: collected, hasMore: first > 0 && collected.length > 0 };
  }

  /** Recent entries, as the model's view of the conversation. */
  recent(limit: number): MasterEntry[] {
    const all = [...this.loaded.entries()].sort(([a], [b]) => a - b).flatMap(([, entries]) => entries);
    return all.slice(-limit);
  }

  lastOrder(): number { return this.nextOrder - 1; }
  position(): { epoch: string; seq: number } { return { epoch: this.epoch, seq: this.seq }; }

  /** Live changes after `seq` of this epoch, or `undefined` when they are no longer all known. */
  since(epoch: string, seq: number): MasterStreamEvent[] | undefined {
    if (epoch !== this.epoch || seq > this.seq) return undefined;
    if (seq === this.seq) return [];
    const oldest = this.buffer[0]?.seq ?? this.seq + 1;
    if (seq + 1 < oldest) return undefined;
    return this.buffer.filter(event => event.seq > seq);
  }

  subscribe(listener: (event: MasterStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  flush(): Promise<void> { return this.writes; }

  private emit(event: MasterStreamEvent): void {
    const numbered = { ...event, seq: ++this.seq } as MasterStreamEvent;
    this.buffer.push(numbered);
    if (this.buffer.length > BUFFERED) this.buffer.splice(0, this.buffer.length - BUFFERED);
    for (const listener of [...this.listeners]) {
      try { listener(numbered); } catch { /* A broken page stream must not stop the others. */ }
    }
  }

  private async segment(index: number): Promise<MasterEntry[]> {
    const known = this.loaded.get(index);
    if (known) return known;
    let entries: MasterEntry[] = [];
    try {
      const saved = await readPrivateJson(join(this.directory, segmentName(index))) as { entries?: unknown };
      if (Array.isArray(saved?.entries)) entries = saved.entries.filter((entry): entry is MasterEntry => Boolean(entry && typeof entry === 'object' && typeof (entry as MasterEntry).id === 'string' && typeof (entry as MasterEntry).order === 'number'));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.loaded.set(index, entries);
    for (const entry of entries) this.byId.set(entry.id, entry);
    return entries;
  }

  private persist(index: number): void {
    const write = async () => {
      const entries = this.loaded.get(index) ?? [];
      await writePrivateJson(join(this.directory, segmentName(index)), JSON.stringify({ entries }));
    };
    this.writes = this.writes.then(write, write).catch(error => { console.error(`Master conversation was not saved: ${error instanceof Error ? error.message : String(error)}`); });
  }
}
