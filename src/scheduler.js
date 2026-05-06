/**
 * Scheduler — AI-generated session schedule driven by USER/routines.md and USER/mood-rules.md.
 *
 * How it works:
 *   1. On startup, generateScheduleFromRoutines() reads routines.md + mood-rules.md and
 *      asks the AI to produce a set of cron-based DJ session descriptors.
 *   2. The result is written to USER/schedule.json (machine-generated — do NOT hand-edit).
 *   3. Cron jobs are set up from schedule.json. When each session fires, a dynamic prompt
 *      is built from the session description + current time, and handleInput() runs the DJ.
 *
 * To change the schedule: edit routines.md or mood-rules.md, then call
 *   POST /api/settings/schedule/regenerate
 * or restart the server. schedule.json is always regenerated from the source files.
 */

import schedule   from 'node-schedule';
import { handleInput } from './router.js';
import { savePlan, peekNext } from './state.js';
import { userPath, ensureUserDir, readUserFile } from './paths.js';
import fs from 'fs';

// ─── Fallback schedule ────────────────────────────────────────────────────────
// Used when routines.md is empty AND schedule.json doesn't exist yet (new user).
const FALLBACK_SESSIONS = [
  {
    name: 'morning-energy',
    cron: '0 7 * * 1-5',
    description: 'Weekday morning — energetic, upbeat, forward-moving start to the day.',
  },
  {
    name: 'morning-weekend',
    cron: '0 9 * * 0,6',
    description: 'Weekend morning — relaxed, feel-good, laid-back coffee-and-sunshine vibe.',
  },
  {
    name: 'afternoon-focus',
    cron: '0 14 * * *',
    description: 'Afternoon — instrumental or minimal-lyric tracks for deep work.',
  },
  {
    name: 'evening-chill',
    cron: '30 18 * * *',
    description: 'Evening wind-down — chill, atmospheric, introspective.',
  },
  {
    name: 'midnight-refill',
    cron: '0 0 * * *',
    description: 'Auto-refill — match the current time and recent listening history.',
  },
];

const SCHEDULE_PATH = () => userPath('schedule.json');

// ─── AI schedule generation ───────────────────────────────────────────────────

const SCHEDULE_GEN_SYSTEM_PROMPT = `\
You are a scheduling assistant for a personal AI radio DJ.
Based on the user's daily routines and mood rules, generate DJ session time slots.

IMPORTANT — respond with this EXACT JSON structure (no markdown, no prose):
{
  "say": "",
  "play": [],
  "reason": "<JSON array as a string — the schedule>",
  "segue": ""
}

The "reason" field must contain a valid JSON array (as a string) where each item is:
{
  "name": "snake_case_id",
  "cron": "minute hour day month weekday",
  "description": "2-3 sentence music/energy description for this time slot"
}

Rules for the schedule:
- Match cron times to the user's actual daily schedule
- Create 4-7 sessions covering their active hours
- Create separate weekday vs weekend sessions when their routines differ
- Always include a midnight auto-refill entry: name="midnight-refill", cron="0 0 * * *"
- The description tells the DJ what energy/mood/genre fits each specific time slot`;

async function _callAI(systemPrompt, userMessage) {
  // Use the active AI backend directly (bypass agent conversation history).
  // Import lazily to avoid circular dependency with router.js.
  const { getActiveAgentName } = await import('./ai/index.js');
  const name = getActiveAgentName();
  const backend = name === 'codex'
    ? await import('./ai/codex.js')
    : await import('./ai/claude.js');
  return backend.generate(systemPrompt, userMessage);
}

/**
 * Read routines.md + mood-rules.md, ask AI to generate a schedule, write schedule.json.
 * Returns the sessions array (or null on failure).
 */
export async function generateScheduleFromRoutines() {
  const routines  = readUserFile('routines.md');
  const moodRules = readUserFile('mood-rules.md');

  if (!routines && !moodRules) {
    console.log('[Scheduler] No routines.md or mood-rules.md found — using fallback schedule');
    _writeSchedule(FALLBACK_SESSIONS);
    return FALLBACK_SESSIONS;
  }

  const userContent = [
    routines  ? `## User Routines\n${routines}`   : '',
    moodRules ? `## Mood Rules\n${moodRules}`      : '',
  ].filter(Boolean).join('\n\n');

  console.log('[Scheduler] Generating schedule from routines.md + mood-rules.md…');
  try {
    const djResponse = await _callAI(SCHEDULE_GEN_SYSTEM_PROMPT, userContent);

    // The AI puts the schedule JSON array in the `reason` field.
    let sessions;
    try {
      sessions = JSON.parse(djResponse.reason);
    } catch {
      // Try to extract a JSON array from anywhere in the response
      const match = (djResponse.reason ?? '').match(/\[[\s\S]*\]/);
      if (match) sessions = JSON.parse(match[0]);
    }

    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error('AI returned no sessions');
    }

    // Validate each entry
    sessions = sessions.filter(s => s.name && s.cron && s.description);
    if (sessions.length === 0) throw new Error('All sessions failed validation');

    // Ensure midnight-refill always present
    if (!sessions.find(s => s.name === 'midnight-refill')) {
      sessions.push({
        name: 'midnight-refill',
        cron: '0 0 * * *',
        description: 'Auto-refill — match the current time and recent listening history.',
      });
    }

    _writeSchedule(sessions);
    console.log(`[Scheduler] Generated ${sessions.length} sessions from routines`);
    return sessions;
  } catch (err) {
    console.warn('[Scheduler] Schedule generation failed:', err.message);
    // Fall back to existing schedule.json or hardcoded defaults
    return _loadExisting() ?? FALLBACK_SESSIONS;
  }
}

function _writeSchedule(sessions) {
  try {
    ensureUserDir();
    const payload = {
      _meta: 'Auto-generated from routines.md + mood-rules.md. Do not hand-edit — re-run POST /api/settings/schedule/regenerate.',
      _generated_at: new Date().toISOString(),
      sessions,
    };
    fs.writeFileSync(SCHEDULE_PATH(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn('[Scheduler] Could not write schedule.json:', err.message);
  }
}

function _loadExisting() {
  try {
    const raw  = fs.readFileSync(SCHEDULE_PATH(), 'utf8');
    const data = JSON.parse(raw);
    // Support both old plain-array format and new {_meta, sessions} format
    const sessions = Array.isArray(data) ? data : data.sessions;
    if (Array.isArray(sessions) && sessions.length > 0 &&
        sessions.every(s => s.name && s.cron && s.description)) {
      return sessions;
    }
  } catch { /* missing or invalid */ }
  return null;
}

// ─── Cron job management ──────────────────────────────────────────────────────

// Build a dynamic session prompt. The DJ already has routines.md in its system
// prompt (via context.js), so the description just anchors the current time slot.
function _buildSessionPrompt(session) {
  const now     = new Date();
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  const dayStr  = now.toLocaleDateString('en-US', { weekday: 'long' });
  return (
    `It's ${timeStr} on ${dayStr}. ` +
    `Session: ${session.description} ` +
    `Build a full session: 8-10 songs in play[] and 10-15 additional songs in candidates[] for the recommendation engine to score.`
  );
}

let _jobs = [];

function _scheduleAll(sessions) {
  for (const job of _jobs) job.cancel();
  _jobs = [];
  for (const session of sessions) {
    const job = schedule.scheduleJob(session.cron, async () => {
      console.log(`[Scheduler] Triggering: ${session.name}`);
      try {
        const result = await handleInput(_buildSessionPrompt(session), session.name);
        if (result.djResponse?.play?.length) {
          const today = new Date().toISOString().slice(0, 10);
          savePlan(today, { session: session.name, tracks: result.djResponse.play, ts: Date.now() });
        }
      } catch (err) {
        console.error(`[Scheduler:${session.name}] error:`, err.message);
      }
    });
    if (job) _jobs.push(job);
  }
}

/**
 * Start scheduler on app boot.
 * Generates schedule.json from routines if needed, then sets up cron jobs.
 */
export async function startScheduler() {
  // Pre-warm queued tracks first (fast, no AI needed).
  setTimeout(async () => {
    const { prewarmCache } = await import('../routes/stream-audio.js');
    const queued = peekNext();
    if (queued.length) {
      prewarmCache(queued.map(r => r.video_id).filter(Boolean));
      console.log(`[Scheduler] Pre-warming ${queued.length} queued tracks`);
    }
  }, 2000);

  // Load existing schedule immediately so cron jobs start without waiting for AI.
  const existing = _loadExisting();
  if (existing) {
    _scheduleAll(existing);
    console.log(`[Scheduler] Started ${existing.length} sessions from cached schedule.json`);
  } else {
    _scheduleAll(FALLBACK_SESSIONS);
    console.log(`[Scheduler] Started ${FALLBACK_SESSIONS.length} fallback sessions`);
  }

  // Regenerate from routines in background (doesn't block startup).
  generateScheduleFromRoutines()
    .then(sessions => {
      if (sessions) {
        _scheduleAll(sessions);
        console.log(`[Scheduler] Schedule updated from routines — ${sessions.length} sessions active`);
      }
    })
    .catch(err => console.warn('[Scheduler] Background schedule generation error:', err.message));
}

/**
 * Reload schedule from routines.md + mood-rules.md (re-run AI generation).
 * Called by POST /api/settings/schedule/regenerate.
 * Returns the newly generated sessions.
 */
export async function regenerateSchedule() {
  const sessions = await generateScheduleFromRoutines();
  if (sessions) _scheduleAll(sessions);
  return sessions;
}

/**
 * Reload schedule.json from disk without re-running AI generation.
 * Useful if schedule.json was manually reviewed and tweaked.
 */
export function reloadSchedule() {
  const sessions = _loadExisting() ?? FALLBACK_SESSIONS;
  _scheduleAll(sessions);
  console.log(`[Scheduler] Reloaded — ${sessions.length} sessions active`);
  return sessions;
}
