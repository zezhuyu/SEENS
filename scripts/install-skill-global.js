#!/usr/bin/env node
/**
 * Installs the SEENS notify skill as a global Claude Code skill.
 *
 * What it does:
 *   1. Copies skills/notify.md  →  ~/.claude/commands/notify.md
 *   2. Copies skills/seens-notify-mcp.js  →  ~/.claude/seens-notify-mcp.js
 *   3. Registers the MCP server in ~/.claude/settings.json under mcpServers
 *
 * After running, restart Claude Code for the skill to appear as /notify in any project.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');

// 1. Install slash-command skill definition
fs.mkdirSync(COMMANDS_DIR, { recursive: true });
const skillSrc  = path.join(ROOT, 'skills', 'notify.md');
const skillDest = path.join(COMMANDS_DIR, 'notify.md');
fs.copyFileSync(skillSrc, skillDest);
console.log(`✓ Skill installed: ${skillDest}`);

// 2. Install MCP server script to ~/.claude/
const mcpSrc  = path.join(ROOT, 'skills', 'seens-notify-mcp.js');
const mcpDest = path.join(CLAUDE_DIR, 'seens-notify-mcp.js');
fs.copyFileSync(mcpSrc, mcpDest);
console.log(`✓ MCP server installed: ${mcpDest}`);

// 3. Merge MCP server entry into ~/.claude/settings.json
const settingsPath = path.join(CLAUDE_DIR, 'settings.json');
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
} catch {
  // File may not exist or be invalid JSON — start fresh
}

settings.mcpServers = settings.mcpServers ?? {};
settings.mcpServers['seens-notify'] = { command: 'node', args: [mcpDest] };

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`✓ Registered in ${settingsPath}`);

console.log('\n✓ Done. Restart Claude Code to activate /notify globally in any project.');
