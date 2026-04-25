/**
 * OpenAI adapter — calls the API directly using OPENAI_API_KEY.
 * Much faster than `codex exec` which has oh-my-codex orchestration overhead.
 *
 * Model default: gpt-4o-mini (~2s, cheap)
 * Override: CODEX_MODEL=gpt-4o in .env for better quality
 */

const CODEX_MODEL = process.env.CODEX_MODEL ?? 'gpt-4o-mini';

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
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage },
      ],
      max_tokens: 800,
      temperature: 1.1,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content ?? '';
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
