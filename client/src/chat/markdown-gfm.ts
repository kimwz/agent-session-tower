import remarkGfm from 'remark-gfm';
import type { Options } from 'react-markdown';

/**
 * GitHub's Markdown additions (tables, task lists, autolinks, strikethrough) as every Markdown in Tower reads them:
 * chats and todo descriptions and comments. Only `~~text~~` strikes text through. A single `~` stays a character, as
 * in Korean ranges ("18~20%, 6~7%"), which GFM's default would otherwise strike through from one `~` to the next.
 */
export const remarkGfmPlugins: NonNullable<Options['remarkPlugins']> = [[remarkGfm, { singleTilde: false }]];
