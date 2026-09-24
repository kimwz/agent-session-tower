import { translate as t, useI18n } from '../i18n/i18n';
import { memo, useRef, useState, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../common/lib';
import { localOnlyAddress, useRemoteContent } from '../remote/remote-content';

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  useI18n();
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  return <div className="code-block"><button aria-label={t("코드 복사")} onClick={() => { void copyText(ref.current?.textContent || '').then(success => { setCopied(success); window.setTimeout(() => setCopied(false), 1500); }); }}>{copied ? <Check size={13} /> : <Copy size={13} />}{copied ? t("복사됨") : t("복사")}</button><pre {...props} ref={ref}>{children}</pre></div>;
}
function Link({ children, node: _, ...props }: ComponentPropsWithoutRef<'a'> & { node?: unknown }) {
  const remote = useRemoteContent();
  if (remote && localOnlyAddress(props.href)) return <span className="markdown-local-link" title={t("{0}에서만 열 수 있는 주소입니다: {1}", { 0: remote, 1: props.href ?? '' })}>{children}</span>;
  return <a {...props} target="_blank" rel="noreferrer noopener">{children}</a>;
}
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  useI18n();
  return <div className="markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: Link, img: ({ alt }) => <span className="attachment-label">{t("[이미지:")}{' '}{alt || t("첨부 파일")}]</span> }}>{children}</ReactMarkdown></div>;
});
