import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { cleanPreview } from '../common/lib';
import { translate as t, useI18n } from '../i18n/i18n';
import { Markdown } from './Markdown';
import type { ChatRunMatch } from './chat-runs';

/** How much of a message may still show at the top before it counts as out of sight. */
const VISIBLE_PX = 36;

/**
 * Your message that what is at the top of the view answers: the last one that starts above it. None while that message
 * can still be read there, or when nothing of yours is above.
 */
export function pinnedMessageId(scroller: HTMLElement): string | undefined {
  const top = scroller.getBoundingClientRect().top;
  let found: HTMLElement | undefined;
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-user-message]')) {
    if (element.getBoundingClientRect().top >= top) break;
    found = element;
  }
  return found && found.getBoundingClientRect().bottom <= top + VISIBLE_PX ? found.dataset.userMessage : undefined;
}

/**
 * Keeps the message you sent at the top of the chat while you read the work that followed it, one line at a time.
 * Opening it shows the whole message; it can be folded again or taken back to where it was sent.
 */
export function PinnedPrompt({ scroller, messages, runMatches }: { scroller: RefObject<HTMLDivElement | null>; messages: readonly ChatMessage[]; runMatches?: ReadonlyMap<string, ChatRunMatch> }) {
  useI18n();
  const [pinned, setPinned] = useState<string>();
  const [open, setOpen] = useState(false);
  const update = useCallback(() => { if (scroller.current) setPinned(pinnedMessageId(scroller.current)); }, [scroller]);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => { element.removeEventListener('scroll', onScroll); cancelAnimationFrame(frame); };
  }, [scroller, update]);
  // New messages move what is at the top; look again once they are laid out.
  useLayoutEffect(update, [messages, update]);
  // A different message folds up again.
  useEffect(() => setOpen(false), [pinned]);
  const message = useMemo(() => pinned ? messages.find(item => item.id === pinned) : undefined, [messages, pinned]);
  if (!message) return <div className="pinned-prompt-anchor" />;
  const text = runMatches?.get(message.id)?.text ?? message.text;
  const jump = () => {
    const element = scroller.current;
    const target = element?.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(message.id)}"]`);
    if (!element || !target) return;
    element.scrollTo({ top: element.scrollTop + target.getBoundingClientRect().top - element.getBoundingClientRect().top - 12, behavior: 'smooth' });
  };
  return <div className="pinned-prompt-anchor">
    <div className={`pinned-prompt${open ? ' open' : ''}`}>
      <button type="button" className="pinned-prompt-line" aria-expanded={open} title={open ? t('접기') : t('보낸 메시지 전체 보기')} onClick={() => setOpen(!open)}>
        <span className="pinned-prompt-label">{t('보낸 메시지')}</span>
        <span className="pinned-prompt-text">{cleanPreview(text, 300) || t('첨부 파일')}</span>
        <ChevronDown size={13} className={open ? 'rotate' : ''} aria-hidden="true" />
      </button>
      {open && <div className="pinned-prompt-body">
        <Markdown>{text}</Markdown>
        <div className="pinned-prompt-actions">
          <button type="button" className="text-button" onClick={jump}><ArrowUp size={12} />{t('보낸 위치로 이동')}</button>
          <button type="button" className="text-button" onClick={() => setOpen(false)}>{t('접기')}<ChevronDown size={12} className="rotate" /></button>
        </div>
      </div>}
    </div>
  </div>;
}
