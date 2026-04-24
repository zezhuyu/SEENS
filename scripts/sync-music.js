#!/usr/bin/env node
import 'dotenv/config';
import { syncAll } from '../music/sync.js';

const force = process.argv.includes('--force');
console.log('[Sync] Starting music sync' + (force ? ' (forced)' : '') + '...');
await syncAll({ force });
console.log('[Sync] Complete');
process.exit(0);
