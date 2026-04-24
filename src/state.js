import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/state.db');

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

// ─── Queue ────────────────────────────────────────────────────────────────────
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
