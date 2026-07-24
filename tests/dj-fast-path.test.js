import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCachedRerankerSessionResponse,
  buildCachedRerankerSessionWithFallback,
  composeFastDjPrompt,
} from '../src/fast-dj-prompt.js';
import { startProgressiveResolution } from '../src/progressive-resolution.js';
import { appendWikipediaFact, wikipediaFactFromContext } from '../src/track-context.js';

test('fast DJ prompt keeps essential behavior within a small context budget', () => {
  const prompt = composeFastDjPrompt({
    persona: 'Return DJ JSON and keep say concise.',
    taste: 'Indie pop, folk, and electronic.',
    routines: 'Weekday afternoons are for focused work.',
    moodRules: 'Afternoons: medium energy.',
    topArtists: 'MUNA, Bon Iver, ODESZA',
    library: 'MUNA: Number One Fan, Silk Chiffon',
    environment: 'Wednesday, 2 PM; Summer',
    nowPlaying: 'Open by Rhye',
    upNext: 'At Home by Jon Bryant',
    blockedTracks: ['Midnight City by M83', 'Electric Feel by MGMT'],
    feedback: 'Likes MUNA; avoid repeatedly skipped tracks.',
    rerankerReference: '1. Silk Chiffon by MUNA',
    sessionContext: 'Coding and wants upbeat music.',
    plugins: 'briefcast: podcasts; endpoint podcast_get',
  });

  assert.match(prompt, /one accurate, interesting fact/i);
  assert.match(prompt, /first song/i);
  assert.match(prompt, /Indie pop/);
  assert.match(prompt, /Do not autonomously repeat/);
  assert.match(prompt, /candidates: always \[\]/i);
  assert.match(prompt, /briefcast/);
  assert.match(prompt, /Reranker preference reference/);
  assert.ok(prompt.length < 12_000, `prompt was ${prompt.length} characters`);
});

test('Wikipedia context adds one bounded sourced fact without another AI call', () => {
  const context = 'SONG "Heroes": "Heroes" is a song by English musician David Bowie. It was released in 1977.\n\nARTIST "David Bowie": David Bowie was an English musician.';
  assert.equal(
    wikipediaFactFromContext(context),
    '"Heroes" is a song by English musician David Bowie.',
  );
  assert.deepEqual(appendWikipediaFact('First up is Heroes by David Bowie.', context), {
    say: 'First up is Heroes by David Bowie. Wikipedia notes: "Heroes" is a song by English musician David Bowie.',
    changed: true,
  });
});

test('Tune In can build a personalized session from cached reranker tracks', () => {
  const response = buildCachedRerankerSessionResponse([
    { title: '在我找到你之前', artist: 'Sabrina 胡恂舞' },
    { title: 'Blocked', artist: 'A' },
    { title: 'First', artist: 'B' },
    { title: 'Second', artist: 'C' },
    { title: 'Third', artist: 'D' },
  ], [{ title: 'Blocked', artist: 'A' }]);
  assert.deepEqual(response.play.map(track => track.title), ['First', '在我找到你之前', 'Second', 'Third']);
  assert.equal(response.playIntent, 'now');
  assert.match(response.reason, /reranker/i);
});

test('cached reranker refill does not fall back to AI when freshness blocks every track', () => {
  const tracks = [
    { title: 'First', artist: 'A' },
    { title: 'Second', artist: 'B' },
    { title: 'Third', artist: 'C' },
  ];
  const response = buildCachedRerankerSessionWithFallback(tracks, tracks);
  assert.deepEqual(response.play, tracks);
  assert.match(response.reason, /reranker/i);
});

test('progressive resolution exposes the first playable track before the rest', async () => {
  let finishRest;
  const restGate = new Promise(resolve => { finishRest = resolve; });
  const tracks = [
    { title: 'First', artist: 'A' },
    { title: 'Second', artist: 'B' },
  ];

  const progressive = startProgressiveResolution(tracks, {
    resolveFirst: async track => ({ ...track, streamUrl: '/first' }),
    resolveRemaining: async track => {
      await restGate;
      return { ...track, streamUrl: '/second' };
    },
  });

  assert.deepEqual(await progressive.first, {
    title: 'First', artist: 'A', streamUrl: '/first',
  });

  let allSettled = false;
  progressive.all.then(() => { allSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(allSettled, false);

  finishRest();
  assert.deepEqual(await progressive.all, [
    { title: 'First', artist: 'A', streamUrl: '/first' },
    { title: 'Second', artist: 'B', streamUrl: '/second' },
  ]);
});
