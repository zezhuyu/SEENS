import express from 'express';
import { readUserFile, readUserJSON } from '../src/paths.js';
const router = express.Router();

router.get('/', (req, res) => {
  const taste = readUserFile('taste.md') || null;
  const playlists = readUserJSON('playlists.json');
  res.json({ taste, playlists });
});

export default router;
