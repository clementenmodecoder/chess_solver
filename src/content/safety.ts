/** Live-game guard: Chess Lens is an analysis tool for puzzles, studies and
 *  finished games. When the page looks like a competitive game in progress
 *  (live-play URL or running clocks), analysis is refused. */

export type PlayContext = 'safe' | 'live-play';

const LIVE_URL_PATTERNS: RegExp[] = [
  // lichess game URLs: /8charId or /8charId/white|black (analysis/study/etc
  // have additional path segments and are excluded by the anchors).
  /^https?:\/\/(?:www\.)?lichess\.org\/[a-zA-Z0-9]{8}(?:\/(?:white|black))?\/?$/,
  /^https?:\/\/(?:www\.)?chess\.com\/game\/live(?:\/|$)/,
  /^https?:\/\/(?:www\.)?chess\.com\/play\/online(?:\/|$)/,
  /^https?:\/\/(?:www\.)?chess\.com\/live(?:\/|$)/,
  /^https?:\/\/(?:www\.)?chess\.com\/game\/daily(?:\/|$)/,
  /^https?:\/\/(?:www\.)?chess\.com\/daily(?:\/|$)/,
  /^https?:\/\/play\.chess\.com\//,
  /^https?:\/\/(?:www\.)?chess24\.com\/.*\/play\//,
];

const SAFE_URL_PATTERNS: RegExp[] = [
  /lichess\.org\/(?:training|study|analysis|practice|editor|broadcast)/,
  /chess\.com\/(?:puzzles|analysis|study|lessons|library|endgames)/,
];

function clockTexts(): string[] {
  // Collect texts that look like chess clocks (mm:ss or h:mm:ss, optional
  // tenths). Scanning leaf elements keeps this cheap.
  const out: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const re = /^\s*\d{1,2}:\d{2}(?:[.:]\d{1,2})?\s*$/;
  let node: Node | null;
  let checked = 0;
  while ((node = walker.nextNode()) && checked < 20000) {
    checked++;
    const text = node.textContent ?? '';
    if (text.length <= 12 && re.test(text)) out.push(text.trim());
  }
  return out;
}

/** Detect whether the current page looks like a live competitive game.
 *  Takes ~1.2s when clock-like text is present (two samples to see if any
 *  clock is actually running). */
export async function detectPlayContext(): Promise<PlayContext> {
  const url = location.href;
  if (SAFE_URL_PATTERNS.some((re) => re.test(url))) return 'safe';
  if (LIVE_URL_PATTERNS.some((re) => re.test(url))) return 'live-play';

  const before = clockTexts();
  if (before.length < 2) return 'safe';
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const after = clockTexts();
  if (after.length < 2) return 'safe';
  // A running clock changed its text between the samples while remaining
  // clock-shaped. Require the count to stay stable to avoid page-load noise.
  const beforeSet = new Map<string, number>();
  for (const t of before) beforeSet.set(t, (beforeSet.get(t) ?? 0) + 1);
  let changed = 0;
  for (const t of after) {
    const n = beforeSet.get(t) ?? 0;
    if (n > 0) beforeSet.set(t, n - 1);
    else changed++;
  }
  if (changed > 0 && Math.abs(before.length - after.length) <= 1) return 'live-play';
  return 'safe';
}
