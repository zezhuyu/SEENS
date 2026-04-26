import { generate, getActiveAgent } from './ai/index.js';
import { buildSystemPrompt } from './context.js';
import { synthesize } from './tts.js';
import { addMessage, enqueue, enqueueNext, recordSuggestions, getPref, setSessionContext } from './state.js';
import { broadcast } from './ws-broadcast.js';
import { resolveTracksOrdered } from '../music/resolver.js';
import { prewarmCache } from '../routes/stream-audio.js';
import { callPlugin } from './plugin-runner.js';

// Simple command patterns that don't need AI
const DIRECT_COMMANDS = [
  { pattern: /^(next|skip)$/i, action: 'next' },
  { pattern: /^(pause|stop)$/i, action: 'pause' },
  { pattern: /^(resume|play)$/i, action: 'resume' },
];

export async function handleInput(input, triggerType = 'user-chat') {
  const trimmed = input.trim();

  // Direct command — no AI needed
  for (const cmd of DIRECT_COMMANDS) {
    if (cmd.pattern.test(trimmed)) {
      broadcast('command', { action: cmd.action });
      return { action: cmd.action, say: null };
    }
  }

  const t0 = Date.now();
  const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  // AI-powered response
  addMessage('user', trimmed);
  const systemPrompt = await buildSystemPrompt(triggerType);
  const { name: agentName } = getActiveAgent();
  console.log(`[Router:${triggerType}] start → AI call (${agentName})`);

  let djResponse;
  try {
    djResponse = await generate(systemPrompt, trimmed);
    console.log(`[Router:${triggerType}] ${ts()} AI done — tracks=${djResponse.play?.length ?? 0}${djResponse.play?.length === 0 ? ` say="${djResponse.say?.slice(0, 80)}"` : ''}`);
  } catch (err) {
    console.error(`[Router:${triggerType}] ${ts()} AI error:`, err.message);
    return { error: err.message };
  }

  // ── Plugin two-pass ─────────────────────────────────────────────────────────
  // Pass 1 may return pluginCall — execute it, then re-run AI with the result.
  let activePluginName = null;
  if (djResponse.pluginCall?.plugin && djResponse.pluginCall?.endpoint) {
    const { plugin: pluginName, endpoint, params = {} } = djResponse.pluginCall;
    activePluginName = pluginName;
    try {
      console.log(`[Router:${triggerType}] ${ts()} plugin call → ${pluginName}/${endpoint}`);
      const pluginData = await callPlugin(pluginName, endpoint, params);
      console.log(`[Router:${triggerType}] ${ts()} plugin result received — re-running AI`);
      const pluginContext =
        `[Plugin result from ${pluginName}/${endpoint}]:\n${JSON.stringify(pluginData, null, 2)}\n\n` +
        `Based on this data, set "pluginAction" to decide what to do: ` +
        `use "play" to stream the audioUrl, "rest-piece" to save imageUrl as art recommendation, or "info" to include in your say.`;
      djResponse = await generate(systemPrompt, `${trimmed}\n\n${pluginContext}`);
      console.log(`[Router:${triggerType}] ${ts()} AI pass-2 done — pluginAction=${djResponse.pluginAction?.type ?? 'none'}`);
    } catch (err) {
      console.warn(`[Router:${triggerType}] plugin call failed: ${err.message}`);
      // Fall through with original response
    }
  }

  // ── Dispatch pluginAction ───────────────────────────────────────────────────
  if (djResponse.pluginAction) {
    const { type, audioUrl, title, imageUrl, text, sourceUrl } = djResponse.pluginAction;
    const pluginLabel = activePluginName ?? 'plugin';

    if (type === 'play' && audioUrl) {
      const pluginTrack = {
        title:          title || 'Podcast Episode',
        artist:         pluginLabel,
        source:         'plugin',
        videoId:        null,
        streamUrl:      `/api/stream/proxy?url=${encodeURIComponent(audioUrl)}`,
        resolvedTitle:  title || 'Podcast Episode',
        resolvedArtist: pluginLabel,
      };
      djResponse = { ...djResponse, play: [pluginTrack, ...(djResponse.play ?? [])] };
      console.log(`[Router:${triggerType}] ${ts()} plugin track queued: "${pluginTrack.title}"`);
    } else if (type === 'rest-piece') {
      broadcast('plugin-rest-piece', {
        title:     title ?? '',
        imageUrl:  imageUrl ?? null,
        text:      text ?? djResponse.say,
        sourceUrl: sourceUrl ?? null,
        source:    pluginLabel,
      });
      console.log(`[Router:${triggerType}] ${ts()} plugin rest-piece broadcast: "${title}"`);
    }
    // 'info' — data is reflected in djResponse.say, no extra action needed
  }

  // Persist session context if the AI captured new info from this message
  if (djResponse.sessionContext) {
    setSessionContext(djResponse.sessionContext);
    broadcast('session-context', { context: djResponse.sessionContext });
  }

  // Note: finalSay may be corrected after resolve — message stored after resolve step

  // Resolve tracks + synthesize TTS in parallel
  // For conversational responses (no tracks), respect the chatSpeak preference.
  // Song intros always get TTS regardless.
  const hasTracks = djResponse.play?.length > 0;
  const chatSpeakOn = getPref('tts.chatSpeak', '1') !== '0';
  const isAutoRefill = triggerType === 'auto-refill';
  // Auto-refills queue tracks silently — TTS fires via the transition mechanism (pendingIntroTTS)
  // when the last current song is nearly done. Generating it here would race and steal the intro.
  const shouldSynthesize = !!djResponse.say && (hasTracks || chatSpeakOn) && !isAutoRefill;

  console.log(`[Router:${triggerType}] ${ts()} starting resolve + TTS in parallel${!shouldSynthesize ? ' (TTS skipped — text-only Q&A)' : ''}`);
  const [resolveResult, ttsResult] = await Promise.allSettled([
    hasTracks ? resolveTracksOrdered(djResponse.play) : Promise.resolve([]),
    shouldSynthesize ? synthesize(djResponse.say) : Promise.resolve(null),
  ]);

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
    resolvedTracks = resolveResult.value;
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

  const firstTrack = resolvedTracks[0] ?? null;

  // Detect and fix AI say/track mismatch (AI hallucinated a different song in say)
  let finalSay = djResponse.say;
  let ttsUrl = null;

  if (firstTrack && finalSay) {
    const title = (firstTrack.resolvedTitle ?? firstTrack.title ?? '').toLowerCase();
    if (title && !finalSay.toLowerCase().includes(title)) {
      const displayTitle  = firstTrack.resolvedTitle  ?? firstTrack.title;
      const displayArtist = firstTrack.resolvedArtist ?? firstTrack.artist ?? '';
      // The DJ hallucinated a different song in say — discard the mismatched description
      // and just announce the actual track cleanly to avoid confusing the listener
      finalSay = displayArtist ? `${displayTitle} by ${displayArtist}` : displayTitle;
      console.log(`[Router:${triggerType}] ${ts()} say mismatch — replaced with actual track: "${finalSay}"`);
      // Re-synthesize (discard parallel TTS result which was for the hallucinated say)
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

  addMessage('assistant', finalSay);
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
}
