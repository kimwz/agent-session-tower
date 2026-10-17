import { useSyncExternalStore } from 'react';
import { translate as t, translateMessage } from '../../i18n/i18n';
import type { TodoClient } from '../todo-store';
import { fileProblem, newJob, runUpload, type UploadIO, type UploadJob } from './upload';

/**
 * The page's uploads: two at a time, each with its progress, a cancel that stops it and tells the server, and a retry
 * that goes on from where the server is. A finished one hands its changes to the store, which shows the file.
 */

const RUNNING = 2;

export class TodoUploads {
  private jobs: UploadJob[] = [];
  private running = new Map<string, AbortController>();
  private listeners = new Set<() => void>();
  private next = 0;
  /** The page is gone: nothing starts, and nothing late is shown or kept. */
  private disposed = false;

  constructor(private readonly io: UploadIO, private readonly client: Pick<TodoClient, 'receive' | 'toast'>) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getJobs = () => this.jobs;

  private set(jobs: UploadJob[]) { this.jobs = jobs; for (const listener of this.listeners) listener(); }
  private patch(key: string, job: Partial<UploadJob>) { this.set(this.jobs.map(item => item.key === key ? { ...item, ...job } : item)); }

  /** Queues files for a task's description, or for one of its comments. Too large ones are refused at once. */
  add(files: readonly (Blob & { name?: string })[], target: { taskId: string; commentId?: string | null }) {
    if (this.disposed) return;
    const accepted: UploadJob[] = [];
    for (const file of files) {
      if (fileProblem(file.size)) { this.client.toast(t('“{0}”: 파일 하나는 100MB 이하여야 합니다.', { 0: file.name ?? '' }), 'error'); continue; }
      accepted.push({ ...newJob(`upload-${++this.next}`, file, target), status: 'waiting' });
    }
    if (!accepted.length) return;
    this.set([...this.jobs, ...accepted]);
    this.pump();
  }

  retry(key: string) {
    const job = this.jobs.find(item => item.key === key);
    if (this.disposed || !job || job.status !== 'failed') return;
    this.patch(key, { status: 'waiting', error: undefined });
    this.pump();
  }

  /** Stops one and tells the server, which drops what it received. Once it is finishing, the file is being made: too late. */
  cancel(key: string) {
    const job = this.jobs.find(item => item.key === key);
    if (!job || job.status === 'finishing') return;
    this.running.get(key)?.abort();
    this.running.delete(key);
    this.set(this.jobs.filter(item => item.key !== key));
    // best-effort: an upload left behind is removed by the server after a day.
    if (job.uploadId) this.io.cancel(job.uploadId).catch(() => undefined);
    this.pump();
  }

  private pump() {
    if (this.disposed) return;
    for (const job of this.jobs) {
      if (this.running.size >= RUNNING) return;
      if (job.status === 'waiting' && !this.running.has(job.key)) void this.run(job);
    }
  }

  private async run(job: UploadJob) {
    const controller = new AbortController();
    this.running.set(job.key, controller);
    try {
      const { changes } = await runUpload(job, this.io, controller.signal, update => { if (this.running.get(job.key) === controller) this.patch(job.key, update); });
      if (this.disposed || this.running.get(job.key) !== controller) return;
      this.client.receive(changes);
      this.set(this.jobs.filter(item => item.key !== job.key));
    } catch (error) {
      if (this.disposed || this.running.get(job.key) !== controller) return;
      this.patch(job.key, { status: 'failed', error: error instanceof Error ? translateMessage(error.message) : String(error) });
    } finally {
      if (this.running.get(job.key) === controller) this.running.delete(job.key);
      this.pump();
    }
  }

  /** Stops everything when the page goes; the server forgets unfinished uploads by itself. */
  dispose() {
    this.disposed = true;
    for (const controller of this.running.values()) controller.abort();
    this.running.clear();
    this.jobs = [];
    this.listeners.clear();
  }
}

export function useUploads(uploads: TodoUploads): UploadJob[] {
  return useSyncExternalStore(uploads.subscribe, uploads.getJobs, uploads.getJobs);
}
