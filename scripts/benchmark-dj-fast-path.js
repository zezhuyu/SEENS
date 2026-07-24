#!/usr/bin/env node

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const maxArg = process.argv.indexOf('--max-ms');
const maxMs = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : 10_000;
const url = process.env.SEENS_CHAT_URL ?? 'http://127.0.0.1:7477/api/chat';
const message = process.env.SEENS_BENCHMARK_MESSAGE ??
  'Start my listening session. Tell me what you have planned and introduce the first track.';

const started = performance.now();
const response = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message }),
  signal: AbortSignal.timeout(Math.max(maxMs * 3, 30_000)),
});
const body = await response.json();
const elapsedMs = performance.now() - started;

assert.equal(response.status, 200, JSON.stringify(body));
assert.ok(body.djResponse?.say, 'DJ response must include spoken text');
assert.match(body.djResponse.say, /Wikipedia notes:/i, 'DJ response must include the bounded Wikipedia fact');
assert.ok(body.resolvedTracks?.[0]?.streamUrl, 'first track must be playable');
assert.ok(
  elapsedMs <= maxMs,
  `DJ fast path took ${elapsedMs.toFixed(0)}ms; limit is ${maxMs}ms`,
);

console.log(JSON.stringify({
  status: 'pass',
  elapsedMs: Math.round(elapsedMs),
  firstTrack: body.resolvedTracks[0].resolvedTitle ?? body.resolvedTracks[0].title,
}));
