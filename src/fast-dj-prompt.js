const clip = (value, max) => {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

const FAST_DJ_RULES = `You are Seens Radio, a concise personal music DJ.

Return one JSON object only with: say, play, candidates, playIntent, reason, segue, sessionContext, pluginCall, and pluginAction.
- say: 1-2 short natural spoken sentences. It must name or clearly identify play[0].
- play: exact title/artist objects with source spotify|apple|youtube|any.
- candidates: always [] on this low-latency path.
- playIntent: now for immediate requests, next for "play next", end for append/session refill.
- A direct song or artist request overrides repeat blocks. Autonomous picks must obey them.
- Questions about the current song return play:[] and playIntent:"end".
- For "this song", use Now Playing or the most recently introduced track; never guess.
- Match the requested count. Otherwise use 3-5 tracks for a session or artist request, and 1-2 for a named song.
- Keep artists varied and use source:"any" for genuine discoveries.
- In the same first response, weave one accurate, interesting fact about the first song or artist into say when you know one confidently. Do not invent facts; use a vivid mood description when uncertain.
- If an available plugin matches the request, return pluginCall:{plugin,endpoint,params} and no fabricated data. Otherwise omit pluginCall.
- Only emit sessionContext when the user supplies or changes an activity, mood, or energy preference.`;

export function composeFastDjPrompt({
  persona = '',
  taste = '',
  routines = '',
  moodRules = '',
  topArtists = '',
  library = '',
  environment = '',
  nowPlaying = '',
  upNext = '',
  blockedTracks = [],
  feedback = '',
  rerankerReference = '',
  sessionContext = '',
  plugins = '',
} = {}) {
  const sections = [
    FAST_DJ_RULES,
    persona && `Additional DJ voice: ${clip(persona, 500)}`,
    taste && `Taste profile:\n${clip(taste, 350)}`,
    routines && `Routine context:\n${clip(routines, 200)}`,
    moodRules && `Mood rules:\n${clip(moodRules, 200)}`,
    topArtists && `Top artists:\n${clip(topArtists, 300)}`,
    library && `Compact library anchors:\n${clip(library, 300)}`,
    environment && `Environment:\n${clip(environment, 400)}`,
    sessionContext && `Current session context:\n${clip(sessionContext, 500)}`,
    nowPlaying && `Now Playing:\n${clip(nowPlaying, 350)}`,
    upNext && `Up Next:\n${clip(upNext, 350)}`,
    blockedTracks.length &&
      `Do not autonomously repeat these recent tracks:\n${clip(blockedTracks.join('\n'), 400)}`,
    feedback && `Feedback:\n${clip(feedback, 300)}`,
    rerankerReference && `Reranker preference reference (favor when it fits the request):\n${clip(rerankerReference, 220)}`,
    plugins && `Available plugins:\n${clip(plugins, 500)}`,
  ];

  return sections.filter(Boolean).join('\n\n---\n\n');
}

export function buildCachedRerankerSessionResponse(referenceTracks, blockedTracks = [], limit = 5) {
  const blocked = new Set(blockedTracks.map(track =>
    `${track.title ?? ''}___${track.artist ?? ''}`.toLowerCase()));
  const seen = new Set();
  const play = (referenceTracks ?? []).filter(track => {
    const key = `${track.title ?? ''}___${track.artist ?? ''}`.toLowerCase();
    if (!track.title || blocked.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
  if (play.length < 3) return null;
  const wikiFriendlyIndex = play.findIndex(track =>
    /^[\x20-\x7E]+$/.test(`${track.title ?? ''}${track.artist ?? ''}`) &&
    !/official (music )?video|lyric video/i.test(track.title ?? ''));
  if (wikiFriendlyIndex > 0) {
    const [wikiFriendly] = play.splice(wikiFriendlyIndex, 1);
    play.unshift(wikiFriendly);
  }
  const first = play[0];
  return {
    say: `Starting with ${first.title}${first.artist ? ` by ${first.artist}` : ''}, selected from your current preference profile.`,
    play,
    candidates: [],
    playIntent: 'now',
    reason: 'Cached personalized reranker session',
    segue: '',
  };
}

export function buildCachedRerankerSessionWithFallback(referenceTracks, blockedTracks = [], limit = 5) {
  // Never bypass repeat protection just because the cache is mostly blocked.
  return buildCachedRerankerSessionResponse(referenceTracks, blockedTracks, limit);
}
