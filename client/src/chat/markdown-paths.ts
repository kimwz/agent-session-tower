import { inlineCodePath, prosePaths } from '../workspace/workspace-paths';

type Node = { type: string; value?: string; children?: Node[]; data?: { hName?: string; hProperties?: Record<string, string> } };
/** Rendered as `data-workspace-path` on the element that shows the path. */
export const PATH_ATTRIBUTE = 'data-workspace-path';
const mark = (path: string) => ({ hProperties: { dataWorkspacePath: path } });
/** Text whose paths are the link's own business, or that is shown as written. */
const UNTOUCHED = new Set(['link', 'linkReference', 'image', 'imageReference', 'definition', 'code', 'html']);

/**
 * Marks absolute paths in prose and in inline code so the page can offer to open them. Only the syntax is judged
 * here; whether a path is in a folder Tower lists is decided when it is shown.
 */
export function remarkWorkspacePaths() {
  return (tree: Node) => { visit(tree); };
}

function visit(parent: Node): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap(node => {
    if (UNTOUCHED.has(node.type)) return [node];
    if (node.type === 'inlineCode') {
      const path = inlineCodePath(node.value ?? '');
      return [path ? { ...node, data: { ...node.data, ...mark(path) } } : node];
    }
    if (node.type === 'text') return split(node);
    visit(node);
    return [node];
  });
}

function split(node: Node): Node[] {
  const text = node.value ?? '';
  const paths = prosePaths(text);
  if (!paths.length) return [node];
  const nodes: Node[] = [];
  let at = 0;
  for (const { start, end, path } of paths) {
    if (start > at) nodes.push({ type: 'text', value: text.slice(at, start) });
    nodes.push({ type: 'text', value: text.slice(start, end), data: { hName: 'span', ...mark(path) } });
    at = end;
  }
  if (at < text.length) nodes.push({ type: 'text', value: text.slice(at) });
  return nodes;
}
