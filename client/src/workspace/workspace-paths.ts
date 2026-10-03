import { localPart, nodeOf } from '../remote/scope';

/*
 * Agents name files by their absolute path on the computer they run on. The page turns such a path into the
 * workspace editor's own terms, a folder Tower lists and a path inside it, so the existing workspace API decides
 * whether it may be read. Nothing here grants access: an unknown folder only means the path stays plain text.
 */

/** A file inside a listed folder: `cwd` is the scoped folder key, `file` its relative path (absent: the folder itself). */
export type WorkspaceFile = { cwd: string; file?: string };

const LINE_SUFFIX = /:\d+(?::\d+)?$/;
/** Top-level segments that are Tower's own addresses rather than files. */
const TOWER_ROUTES = new Set(['api', 'assets']);

/** The absolute path a candidate names, without a `:line[:col]` suffix, or undefined when it is not one. */
export function absolutePath(value: string): string | undefined {
  const path = value.replace(LINE_SUFFIX, '').replace(/\/$/, '');
  if (!path.startsWith('/') || path.includes('\0')) return undefined;
  const segments = path.slice(1).split('/');
  if (segments.length < 2 || segments.some(segment => !segment || segment === '.' || segment === '..')) return undefined;
  return path;
}

/** Percent-escapes decoded as UTF-8; a malformed escape or byte sequence names no file. */
function percentDecoded(value: string): string | undefined {
  if (/%(?![0-9A-Fa-f]{2})/.test(value)) return undefined;
  const text = value.replace(/(?:%[0-9A-Fa-f]{2})+/g, run => new TextDecoder().decode(Uint8Array.from(run.slice(1).split('%'), hex => parseInt(hex, 16))));
  return text.includes('\uFFFD') ? undefined : text;
}

/** A Markdown link target that names a file on the agent's computer rather than a web address or a Tower route. */
export function hrefPath(href: string | undefined): string | undefined {
  if (!href || !href.startsWith('/') || href.startsWith('//')) return undefined;
  const path = percentDecoded(href.replace(/[?#].*$/, ''));
  return path === undefined || TOWER_ROUTES.has(path.split('/')[1] ?? '') ? undefined : absolutePath(path);
}

/** Inline code that is one absolute path, which may hold spaces; a command with flags is not a path. */
export function inlineCodePath(code: string): string | undefined {
  const value = code.trim();
  return value.includes('\n') || /\s-/.test(value) ? undefined : absolutePath(value);
}

const PROSE_PATH = /(^|[\s(\[「『"'“‘:=,，])(\/[^\s`'"<>(){}[\]|「」『』“”‘’]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?。、，]+$/;
/** Hangul written straight after a file name is a particle (`a.md를`), not part of the name. */
const PARTICLE_AFTER_EXTENSION = /^(.*\/[^/]*\.[A-Za-z0-9]{1,10})[ᄀ-ᇿ㄰-㆏가-힯]+$/;

/** Absolute paths written in prose, by their place in `text`. Paths with spaces are only found in code or links. */
export function prosePaths(text: string): Array<{ start: number; end: number; path: string }> {
  const found: Array<{ start: number; end: number; path: string }> = [];
  for (const match of text.matchAll(PROSE_PATH)) {
    let written = match[2].replace(TRAILING_PUNCTUATION, '');
    written = PARTICLE_AFTER_EXTENSION.exec(written)?.[1] ?? written;
    const path = absolutePath(written);
    if (!path) continue;
    const start = match.index + match[1].length;
    found.push({ start, end: start + written.length, path });
  }
  return found;
}

/** The listed folders of one computer (`node` absent: this computer), as scoped folder keys. */
export function workspaceRoots(node: string | undefined, folders: Iterable<string | undefined>): string[] {
  const roots = new Set<string>();
  for (const cwd of folders) if (cwd && nodeOf(cwd) === node && localPart(cwd).startsWith('/')) roots.add(cwd);
  return [...roots];
}

/**
 * The folder and relative path for `path`, from the deepest listed folder holding it. Folder names are compared in
 * NFC, because a folder recorded by macOS may be decomposed while an agent writes composed Hangul; the file part is
 * sent as written, since on Linux the two forms are different files. A folder written exactly as listed wins a tie.
 */
export function resolveWorkspaceFile(path: string, roots: readonly string[]): WorkspaceFile | undefined {
  const segments = path.split('/').filter(Boolean);
  let best: { cwd: string; depth: number; exact: boolean } | undefined;
  for (const cwd of roots) {
    const root = localPart(cwd).split('/').filter(Boolean);
    if (!root.length || root.length > segments.length || root.some((name, index) => name.normalize('NFC') !== segments[index].normalize('NFC'))) continue;
    const exact = root.every((name, index) => name === segments[index]);
    if (!best || root.length > best.depth || (root.length === best.depth && exact && !best.exact)) best = { cwd, depth: root.length, exact };
  }
  if (!best) return undefined;
  const file = segments.slice(best.depth).join('/');
  return file ? { cwd: best.cwd, file } : { cwd: best.cwd };
}
