import { generate, getActiveAgentName, isAgentActive, cancelCurrentCall } from './ai/index.js';
import { rerank, isRerankerEnabled } from './reranker.js';
import { buildSystemPrompt } from './context.js';
import { synthesize } from './tts.js';
import { addMessage, enqueue, enqueueNext, recordSuggestions, getPref, setPref, setSessionContext, setSessionStart } from './state.js';
import { broadcast } from './ws-broadcast.js';
import { resolveTracksOrdered } from '../music/resolver.js';
import { prewarmCache } from '../routes/stream-audio.js';
import { callPlugin } from './plugin-runner.js';

// Truncate large text fields in plugin data before sending to the AI.
// Full article bodies / transcripts can be thousands of tokens; summaries are enough.
const LONG_TEXT_FIELDS = new Set(['content', 'body', 'transcript', 'description', 'text', 'lyricsLrc', 'audioBase64']);
const MAX_FIELD_LEN = 300;
function trimPluginData(data) {
  if (Array.isArray(data)) return data.map(trimPluginData);
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => {
        if (LONG_TEXT_FIELDS.has(k) && typeof v === 'string' && v.length > MAX_FIELD_LEN)
          return [k, v.slice(0, MAX_FIELD_LEN) + '…'];
        if (typeof v === 'object' && v !== null) return [k, trimPluginData(v)];
        return [k, v];
      })
    );
  }
  return data;
}

// Simple command patterns that don't need AI
const DIRECT_COMMANDS = [
  { pattern: /^(next|skip)$/i, action: 'next' },
  { pattern: /^(pause|stop)$/i, action: 'pause' },
  { pattern: /^(resume|play)$/i, action: 'resume' },
];

// Prevent concurrent AI calls — codex CLI cannot safely run in parallel.
let aiCallInFlight = false;
let aiCallGeneration = 0;
let currentTriggerType = null;

export async function handleInput(input, triggerType = 'user-chat') {
  const trimmed = input.trim();

  // Direct command — no AI needed
  for (const cmd of DIRECT_COMMANDS) {
    if (cmd.pattern.test(trimmed)) {
      broadcast('command', { action: cmd.action });
      return { action: cmd.action, say: null };
    }
  }

  if (aiCallInFlight) {
    if (triggerType === 'user-chat' && currentTriggerType !== 'user-chat') {
      // User clicked Tune In (or sent a message) while a lower-priority background call
      // (daily-plan, auto-refill, scheduler) is in progress — cancel it immediately.
      console.log(`[Router:user-chat] preempting in-flight ${currentTriggerType} call`);
      cancelCurrentCall();
      let waited = 0;
      while (aiCallInFlight && waited < 3000) {
        await new Promise(r => setTimeout(r, 50));
        waited += 50;
      }
      if (aiCallInFlight) {
        console.log('[Router:user-chat] preempt timeout — returning busy');
        return { error: 'AI call in progress' };
      }
    } else {
      console.log(`[Router:${triggerType}] skipping — AI call already in flight`);
      return { error: 'AI call in progress' };
    }
  }

  const myGeneration = ++aiCallGeneration;
  aiCallInFlight = true;
  currentTriggerType = triggerType;

  try {

  const t0 = Date.now();
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  // Session lifecycle: start a new session if none exists, or if the last activity
  // was more than 3 hours ago (user came back after a break = fresh dedup slate).
  const SESSION_EXPIRY = 3 * 3600;
  const nowSec = Math.floor(Date.now() / 1000);
  const startedAt = parseInt(getPref('session.started_at', '0')) || 0;
  const lastActivity = parseInt(getPref('session.last_activity', '0')) || 0;
  const sessionExpired = startedAt > 0 && lastActivity > 0 && (nowSec - lastActivity) > SESSION_EXPIRY;
  if (!startedAt || sessionExpired) {
    setSessionStart();
    console.log(`[Router] ${sessionExpired ? 'Session expired — resetting' : 'New session started'}`);
  }
  setPref('session.last_activity', String(nowSec));

  // AI-powered response
  // When the long-running agent is active it manages all conversation memory itself
  // (in ~/.seens/agent/ via Claude session or Codex messages array).
  // Writing to state.db here would duplicate memory in the wrong place.
  const agentActive = isAgentActive();
  if (!agentActive) addMessage('user', trimmed);

  const systemPrompt = await buildSystemPrompt(triggerType, { agentMode: agentActive });
  const agentName = getActiveAgentName();
  console.log(`[Router:${triggerType}] start → AI call (${agentName})`);

  let djResponse;
  try {
    djResponse = await generate(systemPrompt, trimmed);
    console.log(`[Router:${triggerType}] ${ts()} AI pass-1 done`);
    console.log(`[Router:${triggerType}]   tracks=${djResponse.play?.length ?? 0}  say="${djResponse.say?.slice(0, 100)}"`);
    console.log(`[Router:${triggerType}]   pluginCall=${JSON.stringify(djResponse.pluginCall ?? null)}`);
  } catch (err) {
    console.error(`[Router:${triggerType}] ${ts()} AI error:`, err.message);
    return { error: err.message };
  }

  // ── Plugin two-pass ─────────────────────────────────────────────────────────
  // Pass 1 may return pluginCall — execute it, then re-run AI with the result.
  // If audio_url is null (podcast still generating), poll up to 5× with 4s delay.
  let activePluginName = null;
  let pluginRawAudioUrl = null; // raw audio URL from plugin data — avoids AI mangling file:// paths
  let pluginRawImageUrl = null; // raw image URL from plugin data
  let pluginRawTitle = null;    // raw title from plugin data
  if (djResponse.pluginCall?.plugin && djResponse.pluginCall?.endpoint) {
    const { plugin: pluginName, endpoint, params = {} } = djResponse.pluginCall;
    activePluginName = pluginName;

    // Immediately broadcast the pass-1 "hold on" message so the user sees feedback right away.
    // Pass-2 result will arrive as a second dj-response once the plugin data is ready.
    if (djResponse.say) {
      broadcast('dj-response', {
        agent: agentName,
        say: djResponse.say,
        ttsUrl: null,
        play: [],
        firstTrack: null,
        reason: djResponse.reason ?? '',
        segue: '',
        playIntent: 'end',
        trigger: triggerType,
        interim: true,
      });
      console.log(`[Router:${triggerType}] ${ts()} interim pass-1 broadcast: "${djResponse.say.slice(0, 80)}"`);
    }

    try {
      console.log(`[Router:${triggerType}] ${ts()} plugin call → ${pluginName}/${endpoint} params=${JSON.stringify(params)}`);
      let pluginData = await callPlugin(pluginName, endpoint, params);
      console.log(`[Router:${triggerType}] ${ts()} plugin raw response: ${JSON.stringify(pluginData)?.slice(0, 300)}…`);

      // Poll only for single-object results where audio_url is null — the content may still be generating.
      // Arrays (e.g. news_search results) never have audio_url so must not trigger polling.
      const isObject = pluginData !== null && typeof pluginData === 'object' && !Array.isArray(pluginData);
      const MAX_POLLS = 5;
      for (let i = 0; i < MAX_POLLS && isObject && pluginData?.audio_url == null && pluginData?.audioUrl == null; i++) {
        console.log(`[Router:${triggerType}] ${ts()} audio_url null — polling (${i + 1}/${MAX_POLLS})…`);
        await new Promise(r => setTimeout(r, 4_000));
        pluginData = await callPlugin(pluginName, endpoint, params);
        console.log(`[Router:${triggerType}] ${ts()} poll ${i + 1} response: audio_url=${pluginData?.audio_url ?? pluginData?.audioUrl ?? 'null'}`);
      }

      pluginRawAudioUrl = pluginData?.audio_url ?? pluginData?.audioUrl ?? pluginData?.url ?? null;
      pluginRawImageUrl = pluginData?.image_url ?? pluginData?.imageUrl ?? pluginData?.image ?? null;
      pluginRawTitle    = pluginData?.title ?? null;
      console.log(`[Router:${triggerType}] ${ts()} pluginRawAudioUrl="${pluginRawAudioUrl}" imageUrl="${pluginRawImageUrl}" title="${pluginRawTitle}"`);

      // Trim large text fields before sending to AI — full article bodies blow up token count
      const trimmedData = trimPluginData(pluginData);

      const hasAudio = !!pluginRawAudioUrl;
      const hasImage = !!pluginRawImageUrl;
      const pluginContext =
        `[Plugin result from ${pluginName}/${endpoint}]:\n${JSON.stringify(trimmedData, null, 2)}\n\n` +
        `Field mapping — copy values exactly, do not modify:\n` +
        `  audio_url / audioUrl / url → pluginAction.audioUrl\n` +
        `  image_url / imageUrl / image → pluginAction.imageUrl\n` +
        `  title → pluginAction.title\n\n` +
        (hasAudio
          ? `ACTION: Set pluginAction.type="play", pluginAction.audioUrl="${pluginRawAudioUrl}"${hasImage ? `, pluginAction.imageUrl="${pluginRawImageUrl}"` : ''}. Write a brief say introducing the content.\n`
          : hasImage
            ? `ACTION: Set pluginAction.type="rest-piece", pluginAction.imageUrl="${pluginRawImageUrl}", pluginAction.text=<summary of content>. Write a brief say about it.\n`
            : `ACTION: Set pluginAction.type="info". Write a spoken summary of this data directly in the "say" field. Do not say you are fetching — the data is already here.\n`) +
        `Always populate the "say" field with the actual content — never leave it empty, never say you are still fetching.`;

      console.log(`[Router:${triggerType}] ${ts()} running AI pass-2`);
      // Pass-2 system prompt: strip plugin-call instructions (no pluginCall needed now)
      // and Final Reminder (dedup not relevant when responding to fetched data).
      // Keeping them causes the model to re-issue "let me fetch" instead of summarizing.
      const pass2SystemPrompt = systemPrompt
        .split('\n\n---\n\n## Plugins')[0]
        .split('\n\n---\n\n## ⛔ Final Reminder')[0]
        .trimEnd();
      djResponse = await generate(pass2SystemPrompt, `[Data fetched for: "${trimmed}"]\n\n${pluginContext}`);
      console.log(`[Router:${triggerType}] ${ts()} AI pass-2 done`);
      console.log(`[Router:${triggerType}]   pluginAction=${JSON.stringify(djResponse.pluginAction ?? null)}`);
      console.log(`[Router:${triggerType}]   say="${djResponse.say?.slice(0, 100)}"`);
    } catch (err) {
      console.warn(`[Router:${triggerType}] plugin call failed: ${err.message}`);
      console.warn(`[Router:${triggerType}] plugin error stack: ${err.stack?.split('\n').slice(0,3).join(' | ')}`);
      // Run pass-2 with the error so the DJ acknowledges the failure rather than silently saying nothing.
      try {
        const errContext = `[Plugin error for "${trimmed}"]\nThe plugin "${activePluginName}" failed: ${err.message}.\nTell the user the plugin is unavailable and suggest they check that the service is running.`;
        const pass2SystemPrompt = systemPrompt.split('\n\n---\n\n## Plugins')[0].split('\n\n---\n\n## ⛔ Final Reminder')[0].trimEnd();
        djResponse = await generate(pass2SystemPrompt, errContext);
        console.log(`[Router:${triggerType}] plugin error pass-2 say: "${djResponse.say?.slice(0, 100)}"`);
      } catch { /* keep original pass-1 response as last resort */ }
    }
  } else {
    console.log(`[Router:${triggerType}] ${ts()} no pluginCall set by AI — skipping plugin two-pass`);
  }

  // ── Dispatch pluginAction ───────────────────────────────────────────────────
  console.log(`[Router:${triggerType}] ${ts()} dispatch — pluginRawAudioUrl=${pluginRawAudioUrl ? '"' + pluginRawAudioUrl.slice(0,60) + '..."' : 'null'} pluginAction.type=${djResponse.pluginAction?.type ?? 'none'}`);

  // Server-side fallbacks when the AI missed or mis-typed the action.
  // Audio available but AI didn't set type=play → force it.
  if (pluginRawAudioUrl && (!djResponse.pluginAction || djResponse.pluginAction.type !== 'play')) {
    djResponse = {
      ...djResponse,
      pluginAction: {
        ...(djResponse.pluginAction ?? {}),
        type:     'play',
        title:    djResponse.pluginAction?.title ?? pluginRawTitle ?? 'Podcast Episode',
        audioUrl: pluginRawAudioUrl,
        imageUrl: djResponse.pluginAction?.imageUrl ?? pluginRawImageUrl ?? null,
      },
    };
    console.log(`[Router:${triggerType}] pluginAction fallback — forced type=play from raw audio URL`);
  }
  // Image + text but no audio, and AI didn't set type=rest-piece → promote to rest-piece.
  else if (!pluginRawAudioUrl && pluginRawImageUrl &&
           djResponse.pluginAction && djResponse.pluginAction.type === 'info') {
    djResponse = {
      ...djResponse,
      pluginAction: {
        ...djResponse.pluginAction,
        type:     'rest-piece',
        imageUrl: djResponse.pluginAction.imageUrl ?? pluginRawImageUrl,
      },
    };
    console.log(`[Router:${triggerType}] pluginAction fallback — promoted info→rest-piece (image present)`);
  }

  // Shared helper: resolve a relative image URL against the plugin's baseUrl
  async function resolveImageUrl(rawUrl, pluginLabel) {
    if (!rawUrl || /^https?:\/\//.test(rawUrl)) return rawUrl ?? null;
    const { loadPlugins } = await import('./plugin-runner.js');
    const plugin = loadPlugins().find(p => p.name === pluginLabel);
    if (plugin?.baseUrl) return plugin.baseUrl.replace(/\/$/, '') + '/' + rawUrl.replace(/^\//, '');
    return rawUrl;
  }

  if (djResponse.pluginAction) {
    const { type, audioUrl: aiAudioUrl, title, imageUrl, text, sourceUrl } = djResponse.pluginAction;
    const pluginLabel = activePluginName ?? 'plugin';

    // Prefer raw plugin data over AI's copy to avoid URL mangling
    const audioUrl    = pluginRawAudioUrl ?? aiAudioUrl ?? null;
    const resolvedImg = await resolveImageUrl(imageUrl ?? pluginRawImageUrl, pluginLabel);

    if (type === 'play' && audioUrl) {
      // Resolve relative audio URL (e.g. /audio/file.mp3) against plugin's http baseUrl.
      // file:// and http(s):// URLs are kept as-is.
      let resolvedAudio = audioUrl;
      if (audioUrl.startsWith('/')) {
        const { loadPlugins } = await import('./plugin-runner.js');
        const plug = loadPlugins().find(p => p.name === pluginLabel);
        if (plug?.baseUrl && /^https?:\/\//.test(plug.baseUrl)) {
          resolvedAudio = plug.baseUrl.replace(/\/$/, '') + audioUrl;
        }
      }

      // Build stream URL:
      //   file:///absolute/path        →  /api/stream/local?path=...
      //   /absolute/path (no baseUrl)  →  /api/stream/local?path=...
      //   http(s)://...                →  /api/stream/proxy?url=...
      let streamUrl;
      if (resolvedAudio.startsWith('file://')) {
        const filePath = decodeURIComponent(resolvedAudio.slice('file://'.length));
        streamUrl = `/api/stream/local?path=${encodeURIComponent(filePath)}`;
      } else if (resolvedAudio.startsWith('/')) {
        streamUrl = `/api/stream/local?path=${encodeURIComponent(resolvedAudio)}`;
      } else {
        streamUrl = `/api/stream/proxy?url=${encodeURIComponent(resolvedAudio)}`;
      }
      if (!djResponse.say) djResponse = { ...djResponse, say: title || 'Now playing' };
      const pluginTrack = {
        title:          title || 'Podcast Episode',
        artist:         pluginLabel,
        source:         'plugin',
        videoId:        null,
        streamUrl,
        artworkUrl:     resolvedImg,
        resolvedTitle:  title || 'Podcast Episode',
        resolvedArtist: pluginLabel,
      };
      djResponse = { ...djResponse, play: [pluginTrack, ...(djResponse.play ?? [])] };
      console.log(`[Router:${triggerType}] ${ts()} plugin track queued: "${pluginTrack.title}" streamUrl=${streamUrl} artwork=${resolvedImg ?? 'none'}`);

    } else if (type === 'rest-piece') {
      if (!djResponse.say) djResponse = { ...djResponse, say: title || text || 'Check this out' };
      broadcast('plugin-rest-piece', {
        title:     title ?? pluginRawTitle ?? '',
        imageUrl:  resolvedImg,
        text:      text ?? djResponse.say,
        sourceUrl: sourceUrl ?? null,
        source:    pluginLabel,
      });
      console.log(`[Router:${triggerType}] ${ts()} plugin rest-piece: "${title}" imageUrl=${resolvedImg ?? 'none'}`);

    } else if (type === 'info') {
      // AI sometimes puts the summary in pluginAction.text but leaves say empty — use it as fallback.
      if (!djResponse.say && text) {
        djResponse = { ...djResponse, say: text };
        console.log(`[Router:${triggerType}] ${ts()} info fallback — using pluginAction.text as say`);
      }
    }
  }

  // Persist session context if the AI captured new info from this message
  if (djResponse.sessionContext) {
    setSessionContext(djResponse.sessionContext);
    broadcast('session-context', { context: djResponse.sessionContext });
  }

  // Note: finalSay may be corrected after resolve — message stored after resolve step

  // ── Resolve tracks + TTS + reranker all in parallel ──────────────────────────
  // Reranker runs alongside resolve/TTS so it never blocks music from starting.
  // Plugin tracks (audioUrl already resolved) are skipped — no point reranking.
  const hasMusicCandidates = djResponse.play?.length > 0 && !djResponse.pluginAction;
  const hasTracks = djResponse.play?.length > 0;
  const chatSpeakOn = getPref('tts.chatSpeak', '1') !== '0';
  const isAutoRefill = triggerType === 'auto-refill';
  // Auto-refills queue tracks silently — TTS fires via the transition mechanism (pendingIntroTTS)
  // when the last current song is nearly done. Generating it here would race and steal the intro.
  const shouldSynthesize = !!djResponse.say && (hasTracks || chatSpeakOn) && !isAutoRefill;

  console.log(`[Router:${triggerType}] ${ts()} starting resolve + TTS + reranker in parallel${!shouldSynthesize ? ' (TTS skipped — text-only Q&A)' : ''}`);
  const [resolveResult, ttsResult, rerankResult] = await Promise.allSettled([
    hasTracks ? resolveTracksOrdered(djResponse.play) : Promise.resolve([]),
    shouldSynthesize ? synthesize(djResponse.say) : Promise.resolve(null),
    (hasMusicCandidates && isRerankerEnabled()) ? rerank(djResponse.play) : Promise.resolve(null),
  ]);

  // ── Apply reranker ordering to resolved tracks ────────────────────────────────
  // If reranker finished in time, re-sort resolvedTracks to match the ranked order.
  // The AI's pass-1 intro stays as-is (no pass-2 — reranker runs in parallel now).
  if (rerankResult.status === 'fulfilled' && rerankResult.value?.length) {
    const ranked = rerankResult.value;
    console.log(`[Router:${triggerType}] ${ts()} reranker done — top: "${ranked[0]?.title}" by ${ranked[0]?.artist}`);
    djResponse = { ...djResponse, play: ranked };
  } else if (rerankResult.status === 'rejected') {
    console.warn(`[Router:${triggerType}] reranker skipped:`, rerankResult.reason?.message);
  }

  let resolvedTracks = [];
  const defaultIntent = (triggerType === 'user-chat' && hasTracks) ? 'now' : 'end';
  let intent = djResponse.playIntent ?? defaultIntent;

  // Keyword override: user's phrasing is more reliable than AI intent inference
  if (triggerType === 'user-chat') {
    const lower = trimmed.toLowerCase();
    if (/\b(next|after this|queue(?: it)? up|play next)\b/.test(lower)) intent = 'next';
    else if (/\b(add|save for later|put in(?: the)? queue|add to playlist|later)\b/.test(lower) &&
             !/\bnow\b/.test(lower)) intent = 'end';
  }

  const addToQueue = (intent === 'now' || intent === 'next') ? enqueueNext : enqueue;

  if (resolveResult.status === 'fulfilled') {
    let resolvedRaw = resolveResult.value;
    // Re-sort resolved tracks to match reranked order when available
    if (rerankResult.status === 'fulfilled' && rerankResult.value?.length) {
      const ranked = rerankResult.value;
      // Index resolved tracks by BOTH their resolved URI (yt:VIDEO_ID) and title___artist,
      // because ranked items carry the original candidate URI (null for AI-picked songs)
      // while resolved tracks have uri updated to yt:VIDEO_ID after resolution.
      const byId = new Map();
      for (const t of resolvedRaw) {
        const titleKey = `${t.title}___${t.artist}`;
        if (t.uri) byId.set(t.uri, t);
        byId.set(titleKey, t);
      }
      const reordered = ranked
        .map(r => byId.get(r.uri) ?? byId.get(`${r.title}___${r.artist}`) ?? null)
        .filter(Boolean);
      // Append any resolved tracks that didn't appear in ranked result (safety net)
      const reorderedSet = new Set(reordered.map(t => t.uri ?? `${t.title}___${t.artist}`));
      resolvedRaw = [...reordered, ...resolvedRaw.filter(t => !reorderedSet.has(t.uri ?? `${t.title}___${t.artist}`))];
    }
    resolvedTracks = resolvedRaw;
    try {
      addToQueue(resolvedTracks);
      console.log(`[Router:${triggerType}] ${ts()} resolve done — ${resolvedTracks.length}/${djResponse.play?.length ?? 0} tracks (intent=${intent})`);
      prewarmCache(resolvedTracks.map(t => t.videoId));
    } catch (err) {
      console.warn(`[Router:${triggerType}] ${ts()} enqueue failed:`, err.message);
    }
  } else {
    console.warn(`[Router:${triggerType}] ${ts()} resolve failed:`, resolveResult.reason?.message);
    try { addToQueue(djResponse.play.map(t => ({ source: t.source ?? 'any', title: t.title, artist: t.artist ?? '', uri: null }))); } catch {}
  }

  // Always record every suggested track so the dedup list stays accurate.
  // Use resolved titles when available (more canonical); fall back to the raw AI suggestion.
  const tracksToRecord = resolvedTracks.length > 0 ? resolvedTracks : (djResponse.play ?? []);
  try { recordSuggestions(tracksToRecord); } catch (err) {
    console.warn(`[Router:${triggerType}] recordSuggestions failed:`, err.message);
  }

  // The first PLAYABLE track — may differ from resolvedTracks[0] if YouTube failed for track[0].
  // The frontend auto-skips tracks with no streamUrl, so the DJ must announce what will actually play.
  const firstPlayable = resolvedTracks.find(t => t.streamUrl || t.videoId) ?? resolvedTracks[0] ?? null;
  const firstTrack = firstPlayable;

  if (resolvedTracks[0] && firstPlayable && firstPlayable !== resolvedTracks[0]) {
    console.log(`[Router:${triggerType}] ${ts()} play[0] unresolvable — firstTrack shifted to "${firstPlayable.resolvedTitle ?? firstPlayable.title}"`);
  }

  // Detect and fix AI say/track mismatch (AI hallucinated a different song in say).
  // Skip for plugin tracks — the DJ intro doesn't need to literally contain the episode title.
  let finalSay = djResponse.say;
  let ttsUrl = null;

  if (firstTrack && finalSay && firstTrack.source !== 'plugin') {
    const title = (firstTrack.resolvedTitle ?? firstTrack.title ?? '').toLowerCase();
    // Only correct when say explicitly names a different song — not when it's a vibe/story intro.
    // Heuristic: say is a mismatch if it contains none of the firstTrack title words AND is short
    // (likely a bare re-announcement of a wrong track), OR if it directly names a recently played song.
    const sayLower = finalSay.toLowerCase();
    const titleWords = title.split(/\s+/).filter(w => w.length > 3);
    const titleMissing = titleWords.length > 0 && !titleWords.some(w => sayLower.includes(w));
    const isShortBare = finalSay.length < 60 && titleMissing;  // bare "Song by Artist" style wrong announcement
    if (isShortBare) {
      const displayTitle  = firstTrack.resolvedTitle  ?? firstTrack.title;
      const displayArtist = firstTrack.resolvedArtist ?? firstTrack.artist ?? '';
      finalSay = displayArtist ? `${displayTitle} by ${displayArtist}` : displayTitle;
      console.log(`[Router:${triggerType}] ${ts()} say mismatch — replaced with actual track: "${finalSay}"`);
      const corrected = await synthesize(finalSay).catch(err => {
        console.warn(`[Router:${triggerType}] TTS re-synth error:`, err.message);
        return null;
      });
      if (corrected) ttsUrl = corrected.url;
    }
  }

  if (!ttsUrl) {
    if (ttsResult.status === 'fulfilled' && ttsResult.value) {
      ttsUrl = ttsResult.value.url;
      console.log(`[Router:${triggerType}] ${ts()} TTS done → ${ttsUrl}`);
    } else if (ttsResult.status === 'rejected') {
      console.error(`[Router:${triggerType}] ${ts()} TTS error:`, ttsResult.reason?.message);
    }
  }

  if (!agentActive) addMessage('assistant', finalSay);
  console.log(`[Router:${triggerType}] ${ts()} broadcasting — firstTrack="${firstTrack?.resolvedTitle ?? firstTrack?.title ?? 'none'}" videoId=${firstTrack?.videoId ?? 'null'}`);

  broadcast('dj-response', {
    agent: agentName,
    say: finalSay,
    ttsUrl,
    play: resolvedTracks.length ? resolvedTracks : djResponse.play,
    firstTrack,
    reason: djResponse.reason,
    segue: djResponse.segue,
    playIntent: intent,
    trigger: triggerType,   // client uses this to decide immediate vs near-end playback
  });

  return { djResponse, resolvedTracks, ttsUrl, agent: agentName };

  } finally {
    if (aiCallGeneration === myGeneration) {
      aiCallInFlight = false;
      currentTriggerType = null;
    }
  }
}
