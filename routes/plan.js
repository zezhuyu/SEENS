import express from 'express';
import { getTodayPlan } from '../src/state.js';

const router = express.Router();

router.get('/today', (req, res) => {
  const plan = getTodayPlan();
  res.json({ plan, date: new Date().toISOString().slice(0, 10) });
});

export default router;
