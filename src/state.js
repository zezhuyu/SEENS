import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Use SEENS_DATA_DIR (set by Electron to userData) so writes land in
// ~/Library/Application Support/seens-radio/ instead of inside the app bundle.
const DATA_DIR = process.env.SEENS_DATA_DIR ?? path.join(__dirname, '../data');
const DB_PATH = path.join(DATA_DIR, 'state.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

// ─── Schema ───────────────────────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS messages (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    role     TEXT NOT NULL,
    content  TEXT NOT NULL,
    ts       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS plays (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id  TEXT,
    source    TEXT NOT NULL,
    title     TEXT NOT NULL,
    artist    TEXT,
    played_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS queue (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    position        INTEGER NOT NULL,
    track_id        TEXT,
    source          TEXT NOT NULL,
    title           TEXT NOT NULL,
    artist          TEXT,
    uri             TEXT,
    video_id        TEXT,
    stream_url      TEXT,
    preview_url     TEXT,
    artwork_url     TEXT,
    resolved_title  TEXT,
    resolved_artist TEXT,
    added_at        INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS prefs (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS plan (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT NOT NULL UNIQUE,
    schedule_json TEXT NOT NULL,
    created_at    INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- Every track the DJ has ever suggested (used to avoid repetition)
  CREATE TABLE IF NOT EXISTS suggestions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id     TEXT,
    title        TEXT NOT NULL,
    artist       TEXT NOT NULL DEFAULT '',
    suggested_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  -- User like / dislike feedback per track (upserted by title+artist)
  CREATE TABLE IF NOT EXISTS feedback (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   TEXT,
    title      TEXT NOT NULL,
    artist     TEXT NOT NULL DEFAULT '',
    rating     TEXT NOT NULL CHECK(rating IN ('like','dislike')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(title, artist)
  );
`);

// ─── Migrations ───────────────────────────────────────────────────────────────
// Add columns that may not exist in older DB files
const queueCols = db.prepare("PRAGMA table_info(queue)").all().map(r => r.name);
for (const col of ['video_id', 'stream_url', 'preview_url', 'artwork_url', 'resolved_title', 'resolved_artist']) {
  if (!queueCols.includes(col)) {
    db.exec(`ALTER TABLE queue ADD COLUMN ${col} TEXT`);
    console.log(`[DB] Migrated: added queue.${col}`);
  }
}

// ─── Prefs ────────────────────────────────────────────────────────────────────
export function getPref(key, fallback = null) {
  const row = db.prepare('SELECT value FROM prefs WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setPref(key, value) {
  db.prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run(key, String(value));
}

// ─── Messages ─────────────────────────────────────────────────────────────────
export function addMessage(role, content) {
  db.prepare('INSERT INTO messages (role, content) VALUES (?, ?)').run(role, content);
}

export function getRecentMessages(limit = 10) {
  return db.prepare('SELECT role, content FROM messages ORDER BY id DESC LIMIT ?').all(limit).reverse();
}

// Mark the start of a new listening session (recorded as unix epoch in prefs)
export function setSessionStart() {
  setPref('session.started_at', String(Math.floor(Date.now() / 1000)));
  setPref('session.context', ''); // fresh context for each session
}

// DJ-extracted summary of what the user is doing / their mood for this session
export function getSessionContext() {
  return getPref('session.context', '') || null;
}

export function setSessionContext(context) {
  if (typeof context === 'string' && context.trim()) {
    setPref('session.context', context.trim());
  }
}

// All messages since the current session started (falls back to recent messages if no session marked)
export function getSessionMessages(max = 30) {
  const startedAt = parseInt(getPref('session.started_at', '0')) || 0;
  if (!startedAt) return getRecentMessages(max);
  return db.prepare(
    'SELECT role, content FROM messages WHERE ts >= ? ORDER BY id DESC LIMIT ?'
  ).all(startedAt, max).reverse();
}

// ─── Queue ────────────────────────────────────────────────────────────────────

// All tracks currently in the queue (not yet played) — used to prevent re-suggestions
export function getQueueTracks() {
  return db.prepare('SELECT title, artist FROM queue ORDER BY position ASC').all();
}

const QUEUE_INSERT_SQL = `
  INSERT INTO queue
    (position, track_id, source, title, artist, uri, video_id, stream_url, preview_url, artwork_url, resolved_title, resolved_artist)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function insertTrack(stmt, pos, t) {
  stmt.run(
    pos,
    t.id ?? null,
    t.source ?? 'any',
    t.resolvedTitle ?? t.title,
    t.resolvedArtist ?? t.artist ?? null,
    t.uri ?? null,
    t.videoId ?? null,
    t.streamUrl ?? null,
    t.previewUrl ?? null,
    t.artworkUrl ?? null,
    t.resolvedTitle ?? null,
    t.resolvedArtist ?? null,
  );
}

export function enqueue(tracks) {
  const maxRow = db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM queue').get();
  let pos = Number(maxRow.m);
  const insert = db.prepare(QUEUE_INSERT_SQL);
  for (const t of tracks) insertTrack(insert, ++pos, t);
}

// Insert tracks at the front of the queue (before existing items)
export function enqueueNext(tracks) {
  if (!tracks.length) return;
  const minRow = db.prepare('SELECT COALESCE(MIN(position), 1) AS m FROM queue').get();
  let pos = Number(minRow.m) - tracks.length;
  const insert = db.prepare(QUEUE_INSERT_SQL);
  for (const t of tracks) insertTrack(insert, pos++, t);
}

export function dequeue() {
  const row = db.prepare('SELECT * FROM queue ORDER BY position ASC LIMIT 1').get();
  if (!row) return null;
  db.prepare('DELETE FROM queue WHERE id = ?').run(row.id);
  db.prepare('INSERT INTO plays (track_id, source, title, artist) VALUES (?, ?, ?, ?)').run(
    row.track_id, row.source, row.title, row.artist
  );
  // Normalize snake_case DB columns → camelCase for the player
  return {
    ...row,
    videoId:        row.video_id,
    streamUrl:      row.stream_url,
    previewUrl:     row.preview_url,
    artworkUrl:     row.artwork_url,
    resolvedTitle:  row.resolved_title  ?? row.title,
    resolvedArtist: row.resolved_artist ?? row.artist,
  };
}

export function peekNext() {
  return db.prepare('SELECT * FROM queue ORDER BY position ASC LIMIT 2').all();
}

export function clearQueue() {
  db.prepare('DELETE FROM queue').run();
}

// ─── Plays ────────────────────────────────────────────────────────────────────
export function getRecentPlays(limit = 20) {
  return db.prepare('SELECT * FROM plays ORDER BY played_at DESC LIMIT ?').all(limit);
}

// ─── Suggestions ─────────────────────────────────────────────────────────────
export function recordSuggestions(tracks) {
  const stmt = db.prepare('INSERT INTO suggestions (video_id, title, artist) VALUES (?, ?, ?)');
  for (const t of tracks) {
    stmt.run(
      t.videoId ?? t.video_id ?? null,
      t.resolvedTitle ?? t.title,
      t.resolvedArtist ?? t.artist ?? '',
    );
  }
}

// Returns deduplicated recent suggestions (latest first, by title+artist)
export function getRecentSuggestions(limit = 60) {
  return db.prepare(`
    SELECT title, artist FROM (
      SELECT title, artist, MAX(suggested_at) AS last
      FROM suggestions
      GROUP BY lower(title), lower(artist)
      ORDER BY last DESC
    ) LIMIT ?
  `).all(limit);
}

// All unique suggestions made in the current session (since session.started_at).
// Falls back to today's suggestions when no session has been started.
// Used as the strict same-session dedup block — the AI must never repeat these.
export function getSessionSuggestions() {
  const startedAt = parseInt(getPref('session.started_at', '0')) || 0;
  if (!startedAt) return getTodaySuggestions();
  return db.prepare(`
    SELECT title, artist FROM (
      SELECT title, artist, MAX(suggested_at) AS last
      FROM suggestions
      WHERE suggested_at >= ?
      GROUP BY lower(title), lower(artist)
      ORDER BY last DESC
    )
  `).all(startedAt);
}

// All unique suggestions made today (local time)
export function getTodaySuggestions() {
  return db.prepare(`
    SELECT title, artist FROM (
      SELECT title, artist, MAX(suggested_at) AS last
      FROM suggestions
      WHERE date(suggested_at, 'unixepoch', 'localtime') = date('now', 'localtime')
      GROUP BY lower(title), lower(artist)
      ORDER BY last DESC
    )
  `).all();
}

// Suggestions from the last N days (excluding today) — treat as firm block to prevent near-term repeats
export function getRecentCrossSessionSuggestions(days = 7, limit = 300) {
  return db.prepare(`
    SELECT title, artist FROM (
      SELECT title, artist, MAX(suggested_at) AS last
      FROM suggestions
      WHERE date(suggested_at, 'unixepoch', 'localtime') < date('now', 'localtime')
        AND date(suggested_at, 'unixepoch', 'localtime') >= date('now', 'localtime', ? || ' days')
      GROUP BY lower(title), lower(artist)
      ORDER BY last DESC
    ) LIMIT ?
  `).all(`-${days}`, limit);
}

// Suggestions older than N days — softer signal, just for style awareness
export function getCrossSessionSuggestions(limit = 75) {
  return db.prepare(`
    SELECT title, artist FROM (
      SELECT title, artist, MAX(suggested_at) AS last
      FROM suggestions
      WHERE date(suggested_at, 'unixepoch', 'localtime') < date('now', 'localtime', '-7 days')
      GROUP BY lower(title), lower(artist)
      ORDER BY last DESC
    ) LIMIT ?
  `).all(limit);
}

// Feedback aggregated by artist — stronger signal than per-track lists
export function getArtistFeedback() {
  return db.prepare(`
    SELECT
      artist,
      SUM(CASE WHEN rating = 'like'    THEN 1 ELSE 0 END) AS likes,
      SUM(CASE WHEN rating = 'dislike' THEN 1 ELSE 0 END) AS dislikes
    FROM feedback
    WHERE trim(artist) != ''
    GROUP BY lower(trim(artist))
    ORDER BY likes DESC, dislikes DESC
  `).all();
}

// ─── Feedback ─────────────────────────────────────────────────────────────────
export function recordFeedback({ videoId, title, artist, rating }) {
  db.prepare(`
    INSERT INTO feedback (video_id, title, artist, rating)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(title, artist) DO UPDATE
      SET rating = excluded.rating, video_id = excluded.video_id, created_at = unixepoch()
  `).run(videoId ?? null, title, artist ?? '', rating);
}

export function getRecentFeedback(limit = 40) {
  return db.prepare(
    'SELECT title, artist, rating FROM feedback ORDER BY created_at DESC LIMIT ?'
  ).all(limit);
}

// ─── Plan ─────────────────────────────────────────────────────────────────────
export function savePlan(date, schedule) {
  db.prepare('INSERT OR REPLACE INTO plan (date, schedule_json) VALUES (?, ?)').run(date, JSON.stringify(schedule));
}

export function getTodayPlan() {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT * FROM plan WHERE date = ?').get(today);
  return row ? JSON.parse(row.schedule_json) : null;
}

export default db;
