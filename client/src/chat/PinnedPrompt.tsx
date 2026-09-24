import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ArrowUp, ChevronDown } from 'lucide-react';
import type { ChatMessage } from '../../../shared/types';
import { cleanPreview } from '../common/lib';
import { translate as t, useI18n } from '../i18n/i18n';
import { Markdown } from './Markdown';
import type { ChatRunMatch } from './chat-runs';

/** The strip at the top that the pinned message covers: a message reaching into it counts as being at the top. */
const PINNED_PX = 44;
/** Your message from before the loaded page, which what the page starts with answers. */
export const BEFORE_PAGE = ':before-page';

/**
 * Your message that what is at the top of the view answers: the last one that starts above the pinned strip. None while
 * a message of yours is in the strip, or when nothing of yours is above; `BEFORE_PAGE` when the view shows what an
 * earlier, unloaded message led to.
 */
export function pinnedMessageId(scroller: HTMLElement, earlier = false): string | undefined {
  const top = scroller.getBoundingClientRect().top + PINNED_PX;
  let found: HTMLElement | undefined;
  for (const element of scroller.querySelectorAll<HTMLElement>('[data-user-message]')) {
    if (element.getBoundingClientRect().top >= top) break;
    found = element;
  }
  if (!found) return earlier ? BEFORE_PAGE : undefined;
  return found.getBoundingClientRect().bottom <= top ? found.dataset.userMessage : undefined;
}

/**
 * Keeps the message you sent at the top of the chat while you read the work that followed it, one line at a time.
 * Opening it shows the whole message; it can be folded again or taken back to where it was sent.
 */
export function PinnedPrompt({ scroller, messages, previousUser, runMatches }: {
  scroller: RefObject<HTMLDivElement | null>; messages: readonly ChatMessage[]; previousUser?: ChatMessage; runMatches?: ReadonlyMap<string, ChatRunMatch>;
}) {
  useI18n();
  const [pinned, setPinned] = useState<string>();
  const [open, setOpen] = useState(false);
  // The opened message never reaches past the chat, however short it gets.
  const [height, setHeight] = useState<number>();
  const line = useRef<HTMLButtonElement>(null);
  const update = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setPinned(pinnedMessageId(element, Boolean(previousUser)));
    setHeight(Math.max(120, Math.floor(element.clientHeight * 0.6)));
  }, [scroller, previousUser]);
  // Looked at again when the view scrolls, and when anything in it changes size (width, text size, a message opened)
  // without a scroll. Attached before the first paint, so the chat's own first scroll to the latest is seen too.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    let frame = 0;
    const later = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update(); }); };
    element.addEventListener('scroll', later, { passive: true });
    const sizes = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(later);
    sizes?.observe(element);
    const content = element.querySelector('.chat-transcript');
    if (content) sizes?.observe(content);
    later();
    return () => { element.removeEventListener('scroll', later); sizes?.disconnect(); cancelAnimationFrame(frame); };
  }, [scroller, update, messages]);
  // A different message folds up again.
  useEffect(() => setOpen(false), [pinned]);
  const message = useMemo(() => pinned === BEFORE_PAGE ? previousUser : pinned ? messages.find(item => item.id === pinned) : undefined, [messages, pinned, previousUser]);
  if (!message) return <div className="pinned-prompt-anchor" />;
  const text = runMatches?.get(message.id)?.text ?? message.text;
  const fold = () => { setOpen(false); requestAnimationFrame(() => line.current?.focus({ preventScroll: true })); };
  const target = () => scroller.current?.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(message.id)}"]`) ?? undefined;
  const jump = () => {
    const element = scroller.current;
    const found = target();
    if (!element || !found) return;
    element.scrollTo({ top: element.scrollTop + found.getBoundingClientRect().top - element.getBoundingClientRect().top - 12, behavior: 'smooth' });
    // Focus goes where the message is, not to the page, once the bar that held it is gone.
    found.tabIndex = -1;
    found.focus({ preventScroll: true });
  };
  return <div className="pinned-prompt-anchor">
    <div className={`pinned-prompt${open ? ' open' : ''}`} onKeyDown={event => { if (open && event.key === 'Escape') { event.preventDefault(); fold(); } }}>
      <button ref={line} type="button" className="pinned-prompt-line" aria-expanded={open} title={open ? t('접기') : t('보낸 메시지 전체 보기')} onClick={() => setOpen(!open)}>
        <span className="pinned-prompt-label">{t('보낸 메시지')}</span>
        <span className="pinned-prompt-text">{cleanPreview(text, 300) || t('첨부 파일')}</span>
        <ChevronDown size={13} className={open ? 'rotate' : ''} aria-hidden="true" />
      </button>
      {open && <div className="pinned-prompt-body" style={height ? { maxHeight: height } : undefined}>
        <Markdown>{text}</Markdown>
        <div className="pinned-prompt-actions">
          {target() && <button type="button" className="text-button" onClick={jump}><ArrowUp size={12} />{t('보낸 위치로 이동')}</button>}
          <button type="button" className="text-button" onClick={fold}>{t('접기')}<ChevronDown size={12} className="rotate" /></button>
        </div>
      </div>}
    </div>
  </div>;
}
