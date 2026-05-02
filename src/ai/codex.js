/**
 * Local Codex agent adapter — routes through a local server.
 *
 * URL: codex.url pref (set via settings UI) → LOCAL_CODEX_URL env var → localhost default
 * Model override: CODEX_MODEL env var (passed to the local agent as a hint)
 */

import { getPref } from '../state.js';

const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-4o-mini';

function getCodexUrl() {
  return getPref('codex.url', null) ?? process.env.LOCAL_CODEX_URL ?? 'http://localhost:8765/api/chat';
}

const JSON_INSTRUCTION = `
Respond ONLY with a single JSON object (no markdown, no extra text) with these fields:
{
  "say": "<string — what you say aloud, never empty>",
  "play": [{"title":"<string>","artist":"<string>","source":"<spotify|apple|youtube|any>"}],
  "reason": "<string>",
  "segue": "<string>",
  "pluginCall": {"plugin":"<name>","endpoint":"<name>","params":{}} | null,
  "pluginAction": {
    "type": "play | rest-piece | info",
    "title": "<string>",
    "audioUrl": "<copy exactly from plugin result — file://, /abs/path, or https:// — for type=play>",
    "imageUrl": "<copy exactly from plugin result — for type=play artwork or type=rest-piece>",
    "text": "<description or summary — for type=rest-piece>",
    "sourceUrl": "<original URL — optional>"
  } | null
}
pluginAction type rules:
- "play"       → plugin returned audio (audio_url / audioUrl / url). Set audioUrl. Set imageUrl if there is an image.
- "rest-piece" → plugin returned an image + text/article but NO audio. Set imageUrl and text.
- "info"       → plugin returned only text. Summarize in say. Do not set pluginAction, or set type=info.
Always populate say with a spoken intro or summary.`;

// Returns: { say, play: [{title, artist, source}], reason, segue }
export async function generate(systemPrompt, userMessage) {
  const url = getCodexUrl();
  const fullMessage = `${systemPrompt}\n${JSON_INSTRUCTION}\n\n---\nUser: ${userMessage}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: fullMessage,
      agent:   'codex',
      model:   CODEX_MODEL,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Local Codex ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.content ?? data.message ?? data.text ?? data.choices?.[0]?.message?.content ?? '';
  console.log(`[Codex] url=${url} model=${CODEX_MODEL}`);
  console.log(`[Codex] raw response (first 400): ${text.slice(0, 400)}`);
  return parseOutput(text);
}

function parseOutput(text) {
  const cleaned = text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '').trim();
  try {
    return normalize(JSON.parse(cleaned));
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return normalize(JSON.parse(match[0])); } catch { /* fall through */ }
    }
    return { say: cleaned, play: [], reason: '', segue: '' };
  }
}

function normalize(obj) {
  return {
    say:          String(obj.say ?? ''),
    play:         Array.isArray(obj.play) ? obj.play.map(normalizeTrack) : [],
    reason:       String(obj.reason ?? ''),
    segue:        String(obj.segue ?? ''),
    pluginCall:   obj.pluginCall?.plugin ? obj.pluginCall   : null,
    pluginAction: obj.pluginAction?.type ? obj.pluginAction : null,
  };
}

function normalizeTrack(t) {
  return {
    title:  String(t.title ?? t.track ?? t.name ?? t.song ?? ''),
    artist: String(t.artist ?? t.by ?? ''),
    source: String(t.source ?? 'any'),
    uri:    t.uri ?? null,
  };
}
