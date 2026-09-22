export const workspaceMinimumWidth = 420;

export function workspaceOverlayLayout(viewport: number, chat: number, preferredWidth: number) {
  const stacked = chat > 0 && viewport - chat < workspaceMinimumWidth;
  const maxWidth = Math.max(0, viewport - (stacked ? 0 : chat));
  const minWidth = Math.min(workspaceMinimumWidth, maxWidth);
  return { stacked, maxWidth, minWidth, width: stacked ? viewport : Math.max(minWidth, Math.min(preferredWidth, maxWidth)), right: stacked ? 0 : chat };
}
