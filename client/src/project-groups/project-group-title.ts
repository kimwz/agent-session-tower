const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const titleLimit = 32;
// Frame insets, folder/edit controls, gaps, and the reserved Auto Prompt target.
const headerChromeWidth = 146;

export function projectGroupDisplayTitle(title: string): string {
  const characters = Array.from(segments.segment(title), item => item.segment);
  return characters.length > titleLimit ? `${characters.slice(0, titleLimit).join('')}…` : title;
}

export function projectGroupMinimumWidth(title: string, measureText: (value: string) => number): number {
  return Math.max(282, Math.ceil(measureText(projectGroupDisplayTitle(title)) + headerChromeWidth));
}

/** Use the same font as the header so Korean, wide Latin letters, and emoji fit. */
export function projectGroupTitleMeasurer(): (value: string) => number {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return value => Array.from(segments.segment(value)).length * 18;
  context.font = `620 18px ${getComputedStyle(document.documentElement).fontFamily}`;
  return value => context.measureText(value).width;
}
