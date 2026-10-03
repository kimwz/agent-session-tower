import type { ChatMessage } from '../../../shared/types';
import { ChatImage } from './ChatImages';
import { translate as t, useI18n } from '../i18n/i18n';
import { memo, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../common/lib';
import { localOnlyAddress, useRemoteContent } from '../remote/remote-content';
import { hrefPath } from '../workspace/workspace-paths';
import { PATH_ATTRIBUTE, remarkWorkspacePaths } from './markdown-paths';
import { useWorkspaceFiles, WorkspacePath } from './WorkspacePath';

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  useI18n();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="code-block"><button aria-label={t("코드 복사")} onClick={() => { void copyText(ref.current?.textContent || '').then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("복사됨") : t("복사")}</button><pre {...props} ref={ref}>{children}</pre></div>;
}
type Marked<T extends 'span' | 'code'> = ComponentPropsWithoutRef<T> & { node?: unknown; [PATH_ATTRIBUTE]?: string };
function Link({ children, node: _, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const remote = useRemoteContent();
  const files = useWorkspaceFiles();
  const path = files && hrefPath(props.href);
  if (path) return <WorkspacePath path={path} linked>{children}</WorkspacePath>;
  if (remote && localOnlyAddress(props.href)) return <span className="markdown-local-link" title={t("{0}에서만 열 수 있는 주소입니다: {1}", { 0: remote, 1: props.href ?? '' })}>{children}</span>;
  return <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>;
}
function MarkedSpan({ node: _, [PATH_ATTRIBUTE]: path, ...props }: Marked<'span'>) {
  return path ? <WorkspacePath path={path}>{props.children}</WorkspacePath> : <span {...props} />;
}
function MarkedCode({ node: _, [PATH_ATTRIBUTE]: path, ...props }: Marked<'code'>) {
  return path ? <WorkspacePath path={path}><code {...props} /></WorkspacePath> : <code {...props} />;
}
export const Markdown = memo(function Markdown({ children, images }: { children: string; images?: ChatMessage['images'] }) {
  useI18n();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm, remarkWorkspacePaths]} components={{ pre: CodeBlock, a: Link, span: MarkedSpan, code: MarkedCode, img: ({ alt, src }) => { const image = images?.find(image => image.source === src || encodeURI(image.source) === src); return image ? <ChatImage key={image.url} image={image} alt={alt} /> : <span className="attachment-label">{t("[이미지:")}{' '}{alt || t("첨부 파일")}]</span>; } }}>{children}</ReactMarkdown></div>;
});
