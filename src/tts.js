/**
 * TTS synthesis — external API providers.
 *
 * TTS_PROVIDER=elevenlabs  (default) — ElevenLabs, high quality, 10k chars/month free
 * TTS_PROVIDER=openai                — OpenAI tts-1 / tts-1-hd
 * TTS_PROVIDER=say                   — macOS say (fallback, no API needed)
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { getPref } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '../tts-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const PROVIDER = process.env.TTS_PROVIDER ?? 'elevenlabs';

// Returns { url: '/tts/hash.mp3' }
export async function synthesize(text) {
  // Runtime voice override from prefs (set via settings panel)
  const voicePref = getPref('tts.voice', '').trim();
  const cacheKey = `${PROVIDER}::${voicePref}::${text}`;
  const hash = createHash('sha256').update(cacheKey).digest('hex').slice(0, 16);
  const mp3Path = path.join(CACHE_DIR, `${hash}.mp3`);

  if (fs.existsSync(mp3Path)) return { url: `/tts/${hash}.mp3` };

  switch (PROVIDER) {
    case 'openai':   await synthesizeOpenAI(text, mp3Path, voicePref);   break;
    case 'say':      await synthesizeSay(text, mp3Path, voicePref);      break;
    case 'elevenlabs':
    default:         await synthesizeElevenLabs(text, mp3Path, voicePref); break;
  }

  return { url: `/tts/${hash}.mp3` };
}

// ─── ElevenLabs ───────────────────────────────────────────────────────────────
// Voices: https://api.elevenlabs.io/v1/voices
// Free tier: 10,000 chars/month. Sign up at elevenlabs.io
// Voice IDs — common ones:
//   Rachel (calm, warm female):  21m00Tcm4TlvDq8ikWAM
//   Domi  (confident female):    AZnzlk1XvdvUeBnXmlld
//   Josh  (warm male):           TxGEqnHWrfWFTfGW9XjX
//   Adam  (deep male):           pNInz6obpgDQGcFmaJgB
//   Bella (soft female):         EXAVITQu4vr4xnSDxMaL
async function synthesizeElevenLabs(text, outPath, voicePref) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set. Add it to .env or set TTS_PROVIDER=openai');

  const voiceId = (voicePref && voicePref.trim()) || process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_turbo_v2_5', // fastest + cheapest
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ElevenLabs TTS error ${res.status}: ${err}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buffer);
}

// ─── OpenAI TTS ───────────────────────────────────────────────────────────────
// Voices: alloy, echo, fable, onyx, nova, shimmer
// Models: tts-1 (fast, cheaper) | tts-1-hd (higher quality)
const VALID_OPENAI_VOICES = new Set(['alloy','ash','coral','echo','fable','nova','onyx','sage','shimmer']);

async function synthesizeOpenAI(text, outPath, voicePref) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set. Add it to .env or set TTS_PROVIDER=elevenlabs');

  const voice = (voicePref && VALID_OPENAI_VOICES.has(voicePref))
    ? voicePref
    : (process.env.OPENAI_TTS_VOICE ?? 'nova');

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL ?? 'tts-1',
      input: text,
      voice,
      response_format: 'mp3',
    }),
  });

  if (!res.ok) throw new Error(`OpenAI TTS error ${res.status}: ${await res.text()}`);
  fs.writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// ─── macOS say (free fallback) ────────────────────────────────────────────────
async function synthesizeSay(text, mp3Path, voicePref) {
  const voice = (voicePref && voicePref.trim()) || process.env.TTS_VOICE || 'Samantha';
  const aiffPath = mp3Path.replace('.mp3', '.aiff');

  await new Promise((resolve, reject) => {
    const proc = spawn('/usr/bin/say', ['-v', voice, '-o', aiffPath, text]);
    proc.on('close', c => c === 0 ? resolve() : reject(new Error(`say exited ${c}`)));
    proc.on('error', reject);
  });

  await new Promise((resolve, reject) => {
    const proc = spawn('/opt/homebrew/bin/ffmpeg', [
      '-y', '-i', aiffPath, '-codec:a', 'libmp3lame', '-qscale:a', '4', mp3Path,
    ]);
    proc.on('close', c => c === 0 ? resolve() : reject(new Error(`ffmpeg exited ${c}`)));
    proc.on('error', reject);
  });

  fs.unlinkSync(aiffPath);
}

export function pruneCache(maxAgeHours = 48) {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    const full = path.join(CACHE_DIR, f);
    if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
  }
}
