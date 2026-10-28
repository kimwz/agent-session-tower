/** The master tools that hand work to a session: each is exactly one tower_api call (see MasterTools). */
export const SESSION_START_TOOL = 'session_start';
export const SESSION_MESSAGE_TOOL = 'session_message';

/**
 * Tools a master turn (the main master's and an issue master's) calls without the provider's approval review, by the
 * server that offers them. Handing work out does nothing by itself: the receiving session's own turn runs under its own
 * permission mode, where what the work actually does is reviewed. Judging the handed-out text instead stopped the
 * master's delegations (#217). The rest of tower_api reaches every route the owner's pages can and keeps the review.
 */
export const MASTER_APPROVED_TOOLS: Readonly<Record<string, readonly string[]>> = {
  tower_master: [SESSION_START_TOOL, SESSION_MESSAGE_TOOL],
  tower: ['autoPrompt_submit'],
};
