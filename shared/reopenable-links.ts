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
