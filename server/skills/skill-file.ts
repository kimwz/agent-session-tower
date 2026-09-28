/**
 * Reads and writes the frontmatter of a standard `SKILL.md`. Only `name` and `description` are Tower's to change; any
 * other key a skill carries (version, allowed tools, triggers …) is kept exactly as written.
 */
export interface SkillFile { name?: string; description?: string; body: string; frontmatter: string[] }

const OPEN = /^---\r?\n/;

export function parseSkillFile(text: string): SkillFile {
  const source = text.replace(/^﻿/, '');
  if (!OPEN.test(source)) return { body: source, frontmatter: [] };
  const lines = source.split(/\r?\n/);
  const end = lines.indexOf('---', 1);
  if (end < 0) return { body: source, frontmatter: [] };
  const frontmatter = lines.slice(1, end);
  const body = lines.slice(end + 1).join('\n').replace(/^\n/, '');
  return { name: scalar(frontmatter, 'name'), description: scalar(frontmatter, 'description'), body, frontmatter };
}

/** Writes the skill with `name` and `description` replaced in place (or added first), other keys untouched. */
export function formatSkillFile(input: { name: string; description: string; body: string; frontmatter?: string[] }): string {
  let lines = input.frontmatter ?? [];
  const values: Record<string, string> = { name: input.name, description: input.description };
  for (const key of ['description', 'name']) {
    const line = `${key}: ${JSON.stringify(values[key])}`;
    const block = keyBlock(lines, key);
    lines = block ? [...lines.slice(0, block.start), line, ...lines.slice(block.end)] : [line, ...lines];
  }
  const body = input.body.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  return `---\n${lines.join('\n')}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/** The lines of a top-level key: its own line and the indented or blank lines that continue it. */
function keyBlock(lines: string[], key: string): { start: number; end: number } | undefined {
  const start = lines.findIndex(line => line.startsWith(`${key}:`));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || !lines[end].trim())) end++;
  // Blank lines before the next key belong to the layout, not to this value.
  while (end > start + 1 && !lines[end - 1].trim()) end--;
  return { start, end };
}

function scalar(lines: string[], key: string): string | undefined {
  const block = keyBlock(lines, key);
  if (!block) return undefined;
  const first = lines[block.start].slice(key.length + 1).trim();
  const rest = lines.slice(block.start + 1, block.end);
  if (/^[|>][+-]?$/.test(first)) {
    const indent = Math.min(...rest.filter(line => line.trim()).map(line => line.length - line.trimStart().length));
    const content = rest.map(line => line.slice(Number.isFinite(indent) ? indent : 0));
    return (first.startsWith('|') ? content.join('\n') : content.map(line => line.trim()).join(' ').replace(/\s+/g, ' ')).trim();
  }
  const joined = [first, ...rest.map(line => line.trim())].join(' ').trim();
  if (joined.startsWith('"')) {
    try { return JSON.parse(joined) as string; } catch { return joined.slice(1, joined.endsWith('"') ? -1 : undefined); }
  }
  if (joined.startsWith("'")) return joined.slice(1, joined.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  return joined;
}
