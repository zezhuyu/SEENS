import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_CODEX_REASONING_EFFORT,
  codexFastModeArgs,
  codexReasoningArgs,
} from '../src/ai/codex-options.js';
import {
  alignIntroToFirstTrack,
  getTtsDeliveryPolicy,
  shouldRewriteMusicIntro,
} from '../src/intro-policy.js';

test('Codex uses low reasoning by default for DJ recommendations', () => {
  assert.equal(DEFAULT_CODEX_REASONING_EFFORT, 'low');
  assert.deepEqual(codexReasoningArgs({}), [
    '-c',
    'model_reasoning_effort="low"',
  ]);
});

test('Codex Fast service tier is enabled by default and can be disabled', () => {
  assert.deepEqual(codexFastModeArgs({}), [
    '-c', 'service_tier="fast"', '-c', 'features.fast_mode=true',
  ]);
  assert.deepEqual(codexFastModeArgs({ CODEX_FAST_MODE: '0' }), []);
});

test('Codex reasoning effort remains configurable', () => {
  assert.deepEqual(codexReasoningArgs({ CODEX_REASONING_EFFORT: 'medium' }), [
    '-c',
    'model_reasoning_effort="medium"',
  ]);
});

test('ordinary music recommendations skip the second intro AI call', () => {
  assert.equal(shouldRewriteMusicIntro({
    env: {},
    firstTrack: { source: 'youtube' },
    playlistLength: 8,
    playlistChanged: true,
    trackContext: 'Background research',
  }), false);
});

test('researched intro rewriting is available as an explicit opt-in', () => {
  assert.equal(shouldRewriteMusicIntro({
    env: { DJ_ENRICH_INTRO: '1' },
    firstTrack: { source: 'youtube' },
    playlistLength: 8,
    playlistChanged: true,
    trackContext: null,
  }), true);
});

test('plugin playback never enters the music intro rewrite path', () => {
  assert.equal(shouldRewriteMusicIntro({
    env: { DJ_ENRICH_INTRO: '1' },
    firstTrack: { source: 'plugin' },
    playlistLength: 1,
    playlistChanged: true,
    trackContext: 'Background research',
  }), false);
});

test('a stale intro is corrected without another AI call', () => {
  assert.deepEqual(alignIntroToFirstTrack(
    'Here is a mellow song for the evening.',
    { title: 'At Home', artist: 'Jon Bryant', source: 'youtube' },
  ), {
    say: 'First up is At Home by Jon Bryant.',
    changed: true,
  });
});

test('an intro that names the first artist is preserved', () => {
  const say = 'Jon Bryant fits this hour perfectly.';
  assert.deepEqual(alignIntroToFirstTrack(
    say,
    { title: 'At Home', artist: 'Jon Bryant', source: 'youtube' },
  ), { say, changed: false });
});

test('Tune In marks deferred TTS so the client holds the first track', () => {
  assert.deepEqual(getTtsDeliveryPolicy('user-chat', true), {
    deferred: true,
    pending: true,
  });
  assert.deepEqual(getTtsDeliveryPolicy('user-chat', false), {
    deferred: true,
    pending: false,
  });
  assert.deepEqual(getTtsDeliveryPolicy('auto-refill', true), {
    deferred: false,
    pending: false,
  });
});
