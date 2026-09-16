// Queue policy shared by the router and tests. A batch recommendation should
// extend the radio hour; only a focused one/two-track request should jump ahead.
export function resolveQueueIntent({
  triggerType,
  intent,
  trackCount,
  isTuneInRequest = false,
  userText = '',
} = {}) {
  // Background generations (auto-refill, scheduler, scheduled sessions) are
  // queue maintenance only. They must never prepend a batch or request that
  // the renderer starts a new track.
  if (triggerType !== 'user-chat') return 'end';
  if (isTuneInRequest) return 'now';

  const lower = userText.toLowerCase();
  if (/\b(next|after this|queue(?: it)? up|play next)\b/.test(lower)) return 'next';
  if (/\b(add|save for later|put in(?: the)? queue|add to playlist|later)\b/.test(lower) &&
      !/\bnow\b/.test(lower)) return 'end';

  // A model can misclassify a full playlist request as "now". Never let a
  // multi-track response replace the active queue unless this is Tune In.
  return intent === 'now' && trackCount > 2 ? 'end' : (intent ?? 'now');
}
