import schedule from 'node-schedule';
import { handleInput } from './router.js';
import { savePlan, peekNext } from './state.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SESSIONS = [
  { name: 'morning-energy',  cron: '0 7 * * 1-5',  prompt: 'Good morning! Start my weekday morning energy session. Pick 3 upbeat, driving tracks to wake me up — avoid slow or sad songs.' },
  { name: 'morning-weekend', cron: '0 9 * * 0,6',  prompt: 'Weekend morning! Pick 3 feel-good, relaxed tracks for a slow start. Think coffee and sunshine vibes.' },
  { name: 'afternoon-focus', cron: '0 14 * * *',   prompt: 'Mid-afternoon focus session. Pick 3 instrumental or low-lyric tracks that help with deep work — no distracting vocals.' },
  { name: 'evening-chill',   cron: '30 18 * * *',  prompt: 'Evening wind-down. Pick 3 chill, atmospheric tracks to close out the day. Avoid high-energy songs.' },
  { name: 'mood-check',      cron: '0 0 */2 * *', prompt: 'Auto-queue 3 tracks based on time of day and recent listening history. Avoid repeating recent plays. Vary the energy and genre from what was just played.' },
];

export function startScheduler() {
  for (const session of SESSIONS) {
    schedule.scheduleJob(session.cron, async () => {
      console.log(`[Scheduler] Triggering: ${session.name}`);
      try {
        const result = await handleInput(session.prompt, session.name);
        if (result.djResponse?.play?.length) {
          const today = new Date().toISOString().slice(0, 10);
          savePlan(today, { session: session.name, tracks: result.djResponse.play, ts: Date.now() });
        }
      } catch (err) {
        console.error(`[Scheduler:${session.name}] error:`, err.message);
      }
    });
  }

  // Pre-warm any existing queue so tracks are ready when user hits Start Radio
  setTimeout(async () => {
    const { peekNext } = await import('./state.js');
    const { prewarmCache } = await import('../routes/stream-audio.js');
    const queued = peekNext();
    if (queued.length) {
      prewarmCache(queued.map(r => r.video_id).filter(Boolean));
      console.log(`[Scheduler] Pre-warming ${queued.length} queued tracks`);
    }
  }, 2000);

  console.log('[Scheduler] Started', SESSIONS.length, 'scheduled sessions');
}

async function generateDailyPlan() {
  // Skip if queue already has tracks (e.g. server restarted mid-session)
  const existing = peekNext();
  if (existing.length >= 2) {
    console.log(`[Scheduler] Queue already has ${existing.length} tracks — skipping daily plan`);
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const prompt = `Good start to ${today}! Queue 4 tracks to kick off today's listening based on my taste and the current time of day.`;
  try {
    const result = await handleInput(prompt, 'daily-plan');
    if (result.djResponse?.play?.length) {
      savePlan(today, { tracks: result.djResponse.play });
      console.log(`[Scheduler] Daily plan ready — ${result.djResponse.play.length} tracks queued`);
    } else {
      console.warn('[Scheduler] Daily plan returned no tracks — raw say:', result.djResponse?.say?.slice(0, 100));
    }
  } catch (err) {
    console.error('[Scheduler] daily plan error:', err.message);
  }
}
