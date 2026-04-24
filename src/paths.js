import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = path.join(__dirname, '..');
export const DATA_DIR = process.env.SEENS_DATA_DIR ?? path.join(APP_ROOT, 'data');
export const LEGACY_USER_DIR = path.join(APP_ROOT, 'USER');
export const USER_DIR = process.env.SEENS_USER_DIR
  ?? (process.env.SEENS_DATA_DIR ? path.join(DATA_DIR, 'USER') : LEGACY_USER_DIR);

export function ensureUserDir() {
  fs.mkdirSync(USER_DIR, { recursive: true });
  return USER_DIR;
}

export function seedUserDirFromBundle() {
  ensureUserDir();
  if (!fs.existsSync(LEGACY_USER_DIR) || LEGACY_USER_DIR === USER_DIR) {
    return;
  }

  // Inside an Electron asar bundle the source path looks like a file to the OS,
  // not a real directory. fs.cpSync cannot traverse it — skip seeding in that case.
  if (LEGACY_USER_DIR.includes('.asar')) {
    return;
  }

  fs.cpSync(LEGACY_USER_DIR, USER_DIR, {
    recursive: true,
    errorOnExist: false,
    force: false,
  });
}

export function userPath(...segments) {
  return path.join(USER_DIR, ...segments);
}

export function readUserFile(...segments) {
  for (const candidate of [userPath(...segments), path.join(LEGACY_USER_DIR, ...segments)]) {
    try {
      return fs.readFileSync(candidate, 'utf8');
    } catch {}
  }
  return '';
}

export function readUserJSON(...segments) {
  for (const candidate of [userPath(...segments), path.join(LEGACY_USER_DIR, ...segments)]) {
    try {
      return JSON.parse(fs.readFileSync(candidate, 'utf8'));
    } catch {}
  }
  return null;
}
