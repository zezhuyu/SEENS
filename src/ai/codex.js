/**
 * OpenAI adapter — calls the API directly using OPENAI_API_KEY.
 * Much faster than `codex exec` which has oh-my-codex orchestration overhead.
 *
 * Model default: gpt-4o-mini (~2s, cheap)
 * Override: CODEX_MODEL=gpt-4o in .env for better quality
 */

const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-4o-mini';

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
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set in .env');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: CODEX_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt + '\n' + JSON_INSTRUCTION },
        { role: 'user',   content: userMessage },
      ],
      max_tokens: 1500,
      temperature: 1.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? '';
  console.log(`[Codex] finish_reason=${choice?.finish_reason} tokens=${JSON.stringify(data.usage)}`);
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
