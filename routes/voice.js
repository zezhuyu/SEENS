import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

function modelPath() {
  const configured = process.env.SEENS_WHISPER_MODEL ?? process.env.VIBEBRIDGE_WHISPER_MODEL;
  if (configured) return configured;

  // Electron sets SEENS_DATA_DIR to app.getPath('userData'), so the model is
  // stored beside the app's other persistent data and works for every user.
  const modelDir = join(process.env.SEENS_DATA_DIR ?? join(process.cwd(), 'data'), 'models');
  const smallModel = join(modelDir, 'ggml-small.en.bin');
  return existsSync(smallModel)
    ? smallModel
    : join(modelDir, 'ggml-tiny.en.bin');
}

function normalize(text) {
  return text
    .replace(/\[(?:blank[_ ]audio|sound|inaudible|unclear|music|noise|silence)\]/gi, ' ')
    .replace(/\[?\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\s*-->\s*\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\]?/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export default function voiceRoute(req, res) {
  const audio = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  if (audio.length < 44) return res.status(400).json({ error: 'voice recording is empty' });
  if (audio.length > MAX_AUDIO_BYTES) return res.status(413).json({ error: 'voice recording is too large' });

  const dirPromise = mkdtemp(join(tmpdir(), 'seens-voice-'));
  dirPromise.then(async (dir) => {
    const wavPath = join(dir, 'recording.wav');
    try {
      await writeFile(wavPath, audio);
      const selectedModel = modelPath();
      console.log(`[Voice] transcribing with ${selectedModel} (${audio.length} bytes)`);
      const { stdout } = await execFileAsync(process.env.SEENS_WHISPER_CLI ?? 'whisper-cli', [
        '-m', selectedModel, '-f', wavPath, '-l', 'en', '--no-prints', '--no-timestamps', '--no-gpu',
        '--temperature', '0', '--no-fallback', '--suppress-nst',
        '--prompt', 'Play a song. Request music from the DJ.',
      ], { timeout: 60_000, maxBuffer: 1_000_000 });
      const text = normalize(stdout);
      console.log(`[Voice] local transcription ${text ? 'succeeded' : 'empty'} (${audio.length} bytes)`);
      res.json(text ? { text, provider: 'whisper.cpp' } : { text: '', unavailableReason: 'empty_transcript' });
    } catch (error) {
      console.warn('[Voice] local transcription failed:', error?.message ?? error);
      res.status(503).json({ error: 'local voice transcription failed' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }).catch((error) => res.status(503).json({ error: `local voice unavailable: ${error.message}` }));
}
