import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { AGENT_GUIDANCE } from './guidance.js';

export const GUIDANCE_FILE = 'agent-guidance.md';
const BEGIN = '<!-- agent-session-tower:begin (managed by Agent Session Tower; replaced when it starts) -->';
const END = '<!-- agent-session-tower:end -->';
/** Written anywhere in an instruction file, keeps Tower from adding or updating its section there. */
export const OPT_OUT = '<!-- agent-session-tower:off -->';

export interface GuidanceHomes {
  stateDir: string;
  /** Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, normally `~/.claude`). */
  claudeHome: string;
  /** Codex's home (`CODEX_HOME`, normally `~/.codex`). */
  codexHome: string;
}
export type GuidanceOutcome = 'written' | 'unchanged' | 'opted-out' | 'not-installed';
export interface GuidanceResult { claude: GuidanceOutcome; codex: GuidanceOutcome }

/**
 * Keeps Tower's agent guidance in the global instruction files of both providers.
 * Claude Code imports the copy in Tower's state directory; Codex has no imports, so its
 * global AGENTS.md carries the text itself. Everything outside Tower's section is left as is.
 */
export async function installAgentGuidance(homes: GuidanceHomes): Promise<GuidanceResult> {
  const guidanceFile = join(homes.stateDir, GUIDANCE_FILE);
  await mkdir(homes.stateDir, { recursive: true, mode: 0o700 });
  if (await readText(guidanceFile) !== AGENT_GUIDANCE) await replaceFile(guidanceFile, AGENT_GUIDANCE);
  const claude = await isDirectory(homes.claudeHome)
    ? await updateSection(join(homes.claudeHome, 'CLAUDE.md'), `@${guidanceFile}`) : 'not-installed';
  const codex = await isDirectory(homes.codexHome)
    ? await updateSection(await codexInstructions(homes.codexHome), AGENT_GUIDANCE.trimEnd()) : 'not-installed';
  return { claude, codex };
}

/** Codex reads AGENTS.override.md instead of AGENTS.md when it has content. */
async function codexInstructions(home: string): Promise<string> {
  const override = join(home, 'AGENTS.override.md');
  return (await readText(override))?.trim() ? override : join(home, 'AGENTS.md');
}

export function withSection(text: string, body: string): string {
  const section = `${BEGIN}\n${body}\n${END}`;
  const start = text.indexOf(BEGIN);
  const end = start < 0 ? -1 : text.indexOf(END, start);
  if (start >= 0 && end >= 0) return `${text.slice(0, start)}${section}${text.slice(end + END.length)}`;
  if (!text.trim()) return `${section}\n`;
  return `${text.trimEnd()}\n\n${section}\n`;
}

async function updateSection(file: string, body: string): Promise<GuidanceOutcome> {
  const current = await readText(file) ?? '';
  if (current.includes(OPT_OUT)) return 'opted-out';
  const next = withSection(current, body);
  if (next === current) return 'unchanged';
  await replaceFile(file, next);
  return 'written';
}

/** Atomic replacement that writes through a symbolic link (for example into a dotfiles repository). */
async function replaceFile(path: string, content: string): Promise<void> {
  let target = path;
  let mode = 0o644;
  try {
    if ((await lstat(path)).isSymbolicLink()) target = await realpath(path);
    mode = (await stat(target)).mode & 0o777;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}
