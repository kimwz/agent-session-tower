type Node = { type: string; value?: string; children?: Node[] };

/**
 * Shows every line break inside a paragraph or list item as written, as chat apps do. Markdown itself joins such lines;
 * code keeps its own text, and an explicit break is already a break.
 */
export function remarkLineBreaks() {
  return (tree: Node) => { visit(tree); };
}

function visit(parent: Node): void {
  if (!parent.children) return;
  parent.children = parent.children.flatMap(node => {
    if (node.type !== 'text') { visit(node); return [node]; }
    const lines = (node.value ?? '').split(/\r?\n/);
    return lines.flatMap((line, index) => [...index ? [{ type: 'break' }] : [], ...line ? [{ ...node, value: line }] : []]);
  });
}
