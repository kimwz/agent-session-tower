/**
 * Links Tower hands out that the owner may open outside the page (a new window, another app, back from a login in front
 * of Tower): a conversation image (this computer's or a joined one's) and a todo attachment, shown inline or downloaded.
 * Each is matched whole on the raw request target, exactly as Tower issues it, so a match needs no escaping and opening
 * one goes nowhere else.
 */
const CHAT_IMAGE = /^\/api\/(?:nodes\/[a-f0-9]{32}\/)?chat-images\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;
const TODO_FILE = /^\/api\/todos\/files\/[A-Za-z0-9_-]{1,64}(?:\?inline=1)?$/;

export const isChatImageLink = (url: string) => CHAT_IMAGE.test(url);
export const isReopenableLink = (url: string) => CHAT_IMAGE.test(url) || TODO_FILE.test(url);

/** The page's query parameter naming such a link to open once the owner has signed in. */
export const OPEN_AFTER_LOGIN = 'open';

/** The sign-in page's address that opens `link` afterwards. */
export const loginThenOpen = (link: string) => `/?${OPEN_AFTER_LOGIN}=${encodeURIComponent(link)}`;

/**
 * The link a page address asks to open after signing in, and the address without it (so a download, which leaves the
 * page where it is, is not asked for again on the next load); null when there is none, or none Tower hands out.
 */
export function linkToOpen(search: string): { link: string; rest: string } | null {
  const params = new URLSearchParams(search);
  const link = params.get(OPEN_AFTER_LOGIN);
  if (!link || !isReopenableLink(link)) return null;
  params.delete(OPEN_AFTER_LOGIN);
  const rest = params.toString();
  return { link, rest: rest ? `?${rest}` : '' };
}
