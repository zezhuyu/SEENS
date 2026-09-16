import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveQueueIntent } from '../src/playback-policy.js';
import { isAcceptedTuneIn } from '../src/tune-in-policy.js';
import { buildCachedRerankerSessionWithFallback } from '../src/fast-dj-prompt.js';

test('multi-track user recommendations append instead of replacing active playback', () => {
  assert.equal(resolveQueueIntent({
    triggerType: 'user-chat',
    intent: 'now',
    trackCount: 5,
    userText: 'give me something upbeat',
  }), 'end');
});

test('background generations always append, regardless of model intent', () => {
  assert.equal(resolveQueueIntent({
    triggerType: 'auto-refill',
    intent: 'now',
    trackCount: 8,
  }), 'end');
  assert.equal(resolveQueueIntent({
    triggerType: 'morning-session',
    intent: 'next',
    trackCount: 8,
  }), 'end');
});

test('a focused song request can still play immediately', () => {
  assert.equal(resolveQueueIntent({
    triggerType: 'user-chat',
    intent: 'now',
    trackCount: 1,
    userText: 'play this song now',
  }), 'now');
});

test('explicit next and append language remains authoritative', () => {
  assert.equal(resolveQueueIntent({ triggerType: 'user-chat', intent: 'now', trackCount: 8, userText: 'play these next' }), 'next');
  assert.equal(resolveQueueIntent({ triggerType: 'user-chat', intent: 'now', trackCount: 1, userText: 'save this for later' }), 'end');
});

test('cached tune-in does not reuse blocked tracks as a fallback', () => {
  const reference = [
    { title: 'One', artist: 'A' },
    { title: 'Two', artist: 'B' },
    { title: 'Three', artist: 'C' },
  ];
  const blocked = reference.map(track => ({ ...track }));
  assert.equal(buildCachedRerankerSessionWithFallback(reference, blocked, 3), null);
});

test('Tune In accepts only its one-use session-start token', () => {
  assert.equal(isAcceptedTuneIn({ requestId: 'a', pendingRequestId: 'a' }), true);
  assert.equal(isAcceptedTuneIn({ requestId: null, pendingRequestId: '__unpaired__' }), true);
  assert.equal(isAcceptedTuneIn({ requestId: 'b', pendingRequestId: 'a' }), false);
  assert.equal(isAcceptedTuneIn({ requestId: null, pendingRequestId: '' }), false);
});
