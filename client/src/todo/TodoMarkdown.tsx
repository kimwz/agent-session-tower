import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** A description or comment as Markdown; links open in a new tab. */
export const TodoMarkdown = memo(function TodoMarkdown({ children }: { children: string }) {
  return <div className="markdown todo-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _, ...props }) => <a {...props} target="_blank" rel="noreferrer noopener" /> }}>{children}</ReactMarkdown></div>;
});
