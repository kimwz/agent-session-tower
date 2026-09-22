import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

const darkHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: '#c6a7f5' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#b8d5f5' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#8dccff' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#f0ca87' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#dce6f3' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#f1be91' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#8cdddf' },
  { tag: [tags.meta, tags.comment], color: '#91a7bf' },
  { tag: [tags.string, tags.inserted], color: '#a6d799' },
  { tag: tags.heading, color: '#9dccff', fontWeight: 'bold' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' },
  { tag: tags.invalid, color: '#ffaaa8' },
]));

export function WorkspaceEditor({ path, content, onChange, onSave }: { path: string; content: string; onChange: (content: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const change = useRef(onChange); change.current = onChange;
  const save = useRef(onSave); save.current = onSave;
  const initial = useRef(content);
  useEffect(() => {
    if (!host.current) return;
    const language = /\.[cm]?[jt]sx?$/.test(path) ? javascript({ typescript: /\.tsx?$/.test(path), jsx: /x$/.test(path) }) : /\.json$/.test(path) ? json() : /\.md$/.test(path) ? markdown() : [];
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: initial.current, extensions: [basicSetup, darkHighlighting, language, keymap.of([{ key: 'Mod-s', run: () => { save.current(); return true; } }]), EditorView.updateListener.of(update => { if (update.docChanged) change.current(update.state.doc.toString()); }), EditorView.theme({ '&': { height: '100%', backgroundColor: '#111b29', color: '#dce6f3' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, monospace', fontSize: '13px' }, '.cm-gutters': { backgroundColor: '#142031', color: '#839bb7', border: 'none' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#203047' }, '.cm-cursor': { borderLeftColor: '#e1edff' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: '#355276' } }, { dark: true }), EditorView.contentAttributes.of({ 'aria-label': path })] }) });
    return () => view.destroy();
  }, [path]);
  return <div className="workspace-editor" ref={host} />;
}
