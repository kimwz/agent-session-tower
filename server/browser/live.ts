import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateJson, writePrivateJson } from '../stores/private-json.js';

/**
 * The browsers Tower's browser tools started on this computer. A browser outlives its tool server when that server is
 * killed outright (Playwright starts it in its own process group), so each server records its browser, and the next
 * server to start ends browsers whose server is gone.
 */
export interface LiveBrowser { serverPid: number; browserPid: number; marker: string; startedAt: string }

/** The switch that names a browser as this record's; Chrome ignores switches it does not know. */
export const markerSwitch = (marker: string) => `--tower-browser=${marker}`;
export const liveDir = (stateDir: string) => join(stateDir, 'browser', 'live');
const recordPath = (stateDir: string, serverPid: number) => join(liveDir(stateDir), `${serverPid}.json`);

export interface ProcessProbe {
  alive(pid: number): boolean;
  /** The process's command line, or undefined when it is gone. */
  command(pid: number): Promise<string | undefined>;
  kill(pid: number, signal: NodeJS.Signals): void;
}

export const systemProbe: ProcessProbe = {
  alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } },
  command: pid => new Promise(done => execFile('ps', ['-ww', '-o', 'command=', '-p', String(pid)], (error, stdout) => done(error ? undefined : stdout.trim() || undefined))),
  // best-effort: a process that is already gone needs no signal.
  kill(pid, signal) { try { process.kill(pid, signal); } catch { /* Already gone. */ } },
};

/** The browser's main process: the one whose command line carries the marker and is not one of its helpers. */
export async function findBrowserPid(marker: string): Promise<number | undefined> {
  const listing = await new Promise<string>(done => execFile('ps', ['-A', '-ww', '-o', 'pid=,command='], { maxBuffer: 16_000_000 }, (error, stdout) => done(error ? '' : stdout)));
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (match && match[2].includes(markerSwitch(marker)) && !match[2].includes('--type=')) return Number(match[1]);
  }
  return undefined;
}

export async function recordBrowser(stateDir: string, browser: LiveBrowser): Promise<void> {
  await mkdir(liveDir(stateDir), { recursive: true, mode: 0o700 });
  await writePrivateJson(recordPath(stateDir, browser.serverPid), JSON.stringify(browser));
}

export async function forgetBrowser(stateDir: string, serverPid: number): Promise<void> {
  // best-effort: a record left behind is removed by the next reaper once this process is gone.
  await unlink(recordPath(stateDir, serverPid)).catch(() => {});
}

/**
 * Ends browsers whose tool server is gone. A browser is signalled only while its command line still carries the
 * marker recorded for it, so a reused process ID is never touched. The temporary profile Playwright gave it goes too,
 * and only when it is Playwright's own folder in the system temporary directory.
 */
export async function reapBrowsers(stateDir: string, probe: ProcessProbe = systemProbe, options: { graceMs?: number; tempDir?: string } = {}): Promise<number> {
  let names: string[];
  // best-effort: no folder means no browser was ever recorded.
  try { names = await readdir(liveDir(stateDir)); } catch { return 0; }
  let reaped = 0;
  // A record a reaper claimed and then died with is put back for this round.
  for (const name of names) {
    const claim = /^(\d+\.json)\.reaping-(\d+)$/.exec(name);
    // best-effort: another reaper may have put it back first.
    if (claim && !probe.alive(Number(claim[2])) && await rename(join(liveDir(stateDir), name), join(liveDir(stateDir), claim[1])).then(() => true, () => false)) names.push(claim[1]);
  }
  for (const name of [...new Set(names)].filter(name => /^\d+\.json$/.test(name))) {
    const path = join(liveDir(stateDir), name);
    let record: LiveBrowser;
    // best-effort: an unreadable record names no browser that could be checked; drop it.
    try { record = await readPrivateJson(path, 64_000) as LiveBrowser; } catch { await unlink(path).catch(() => {}); continue; }
    // best-effort: a malformed record names no browser that could be checked; drop it.
    if (!Number.isInteger(record.serverPid) || !Number.isInteger(record.browserPid) || typeof record.marker !== 'string' || !/^[a-f\d]{32}$/.test(record.marker)) { await unlink(path).catch(() => {}); continue; }
    if (probe.alive(record.serverPid)) continue;
    // One reaper per record: whoever renames it first handles it.
    const claimed = `${path}.reaping-${process.pid}`;
    try { await rename(path, claimed); } catch { continue; }
    const marked = async () => (await probe.command(record.browserPid))?.includes(markerSwitch(record.marker)) === true;
    const command = await probe.command(record.browserPid);
    if (command?.includes(markerSwitch(record.marker))) {
      probe.kill(record.browserPid, 'SIGTERM');
      await delay(options.graceMs ?? 2_000);
      if (await marked()) { probe.kill(record.browserPid, 'SIGKILL'); await delay(200); }
      // Still there: keep the record for the next start rather than lose track of it.
      // best-effort: if putting it back fails, the claim file is put back by the next round (see above).
      if (await marked()) { await rename(claimed, path).catch(() => {}); continue; }
      const profile = playwrightProfile(command, options.tempDir ?? tmpdir());
      // best-effort: a temporary profile left behind is the system's to clean.
      if (profile) await rm(profile, { recursive: true, force: true }).catch(() => {});
      reaped++;
    }
    // best-effort: the claim names a browser that is gone; a leftover file is dropped on the next round.
    await unlink(claimed).catch(() => {});
  }
  return reaped;
}

/** The `--user-data-dir` of a Playwright-launched browser, accepted only as Playwright's folder directly in `tempDir`. */
export function playwrightProfile(command: string, tempDir: string): string | undefined {
  const value = /--user-data-dir=(\S+)/.exec(command)?.[1];
  if (!value) return undefined;
  const path = resolve(value);
  return dirname(path) === resolve(tempDir) && basename(path).startsWith('playwright_chromiumdev_profile-') ? path : undefined;
}
