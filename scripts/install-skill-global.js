#!/usr/bin/env node
/**
 * Installs SEENS notification skill globally for BOTH Claude Code and Codex.
 *
 * Claude:
 *   - ~/.claude/skills/seens-notify/SKILL.md
 *   - ~/.claude/commands/notify.md (slash-command compatibility)
 *   - ~/.claude/seens-notify-mcp.js
 *   - ~/.claude/settings.json -> mcpServers.seens-notify
 *   - ~/.claude/CLAUDE.md completion directive
 *
 * Codex:
 *   - ~/.codex/skills/seens-notify/SKILL.md
 *   - ~/.codex/seens-notify-mcp.js
 *   - ~/.codex/config.toml -> [mcp_servers.seens_notify]
 *   - ~/.codex/AGENTS.md completion directive
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOME = os.homedir();

const CLAUDE_DIR = path.join(HOME, '.claude');
const CODEX_DIR = path.join(HOME, '.codex');

const SKILL_SRC_MD = path.join(ROOT, 'skills', 'notify.md');
const MCP_SRC = path.join(ROOT, 'skills', 'seens-notify-mcp.js');

const COMPLETION_BLOCK_START = '<!-- seens-notify:completion:start -->';
const COMPLETION_BLOCK_END = '<!-- seens-notify:completion:end -->';
function buildCompletionBlock(toolName) {
  return `${COMPLETION_BLOCK_START}
## SEENS completion notification

When a task is finished (success, failure, or blocked), call \`${toolName}\` once with:
- \`title\`: short completion headline
- \`message\`: concise result + key blocker/next step
- \`type\`: \`success\` | \`error\` | \`warning\` | \`info\`

If the MCP tool is unavailable, fall back to curl POST \`/api/notify\` on localhost.
${COMPLETION_BLOCK_END}`;
}

const PERMISSION_BLOCK_START = '<!-- seens-notify:permission:start -->';
const PERMISSION_BLOCK_END = '<!-- seens-notify:permission:end -->';
const PERMISSION_BLOCK = `${PERMISSION_BLOCK_START}
## User permission before sensitive commands

Before running a command that is potentially destructive, writes outside the workspace, uses the network, opens GUI apps, or otherwise requires elevated approval, stop and require explicit user permission through the harness approval flow.

Do not try to work around approval requirements. Prefer safe read-only inspection first, then request approval only for the specific command that needs it.
${PERMISSION_BLOCK_END}`;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readTextOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

function upsertNamedBlock(file, startMarker, endMarker, block) {
  const current = readTextOrEmpty(file);
  const blockRegex = new RegExp(
    `${startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );

  let next;
  if (!current.trim()) {
    next = `${block}\n`;
  } else if (blockRegex.test(current)) {
    next = current.replace(blockRegex, block);
  } else {
    next = `${current.replace(/\s*$/, '')}\n\n${block}\n`;
  }

  writeText(file, next);
}

function setInstructionDirectives(file, completionToolName) {
  upsertNamedBlock(
    file,
    COMPLETION_BLOCK_START,
    COMPLETION_BLOCK_END,
    buildCompletionBlock(completionToolName)
  );
  upsertNamedBlock(file, PERMISSION_BLOCK_START, PERMISSION_BLOCK_END, PERMISSION_BLOCK);
}

function buildCodexSkillMarkdown() {
  let body = readTextOrEmpty(SKILL_SRC_MD).trim();
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end !== -1) body = body.slice(end + 4).trim();
  }
  return `---
name: seens-notify
description: Send SEENS widget notifications; use at task completion.
---

${body}\n`;
}

function installClaude() {
  const claudeSkillDest = path.join(CLAUDE_DIR, 'skills', 'seens-notify', 'SKILL.md');
  const claudeCommandDest = path.join(CLAUDE_DIR, 'commands', 'notify.md');
  const claudeMcpDest = path.join(CLAUDE_DIR, 'seens-notify-mcp.js');
  const claudeSettingsPath = path.join(CLAUDE_DIR, 'settings.json');
  const claudeInstructionsPath = path.join(CLAUDE_DIR, 'CLAUDE.md');

  // Install skill + slash command + MCP server script
  writeText(claudeSkillDest, buildCodexSkillMarkdown());
  copyFile(SKILL_SRC_MD, claudeCommandDest);
  copyFile(MCP_SRC, claudeMcpDest);

  // Register MCP server in Claude settings
  let settings = {};
  try {
    settings = JSON.parse(readTextOrEmpty(claudeSettingsPath) || '{}');
  } catch {
    settings = {};
  }
  settings.mcpServers = settings.mcpServers ?? {};
  settings.mcpServers['seens-notify'] = { command: 'node', args: [claudeMcpDest] };
  writeText(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n');

  // Add completion directive
  setInstructionDirectives(claudeInstructionsPath, 'mcp__seens-notify__notify');

  console.log(`✓ Claude skill installed: ${claudeSkillDest}`);
  console.log(`✓ Claude slash command installed: ${claudeCommandDest}`);
  console.log(`✓ Claude MCP server installed: ${claudeMcpDest}`);
  console.log(`✓ Claude MCP registered: ${claudeSettingsPath}`);
  console.log(`✓ Claude completion directive updated: ${claudeInstructionsPath}`);
}

function upsertCodexMcpServer(configPath, mcpScriptPath) {
  let content = readTextOrEmpty(configPath);
  if (!content.trim()) content = '';

  const block = `[mcp_servers.seens_notify]
command = "node"
args = ["${mcpScriptPath.replace(/"/g, '\\"')}"]
enabled = true
startup_timeout_sec = 5
`;

  const headerRegex = /^\[mcp_servers\.seens_notify\]$/m;
  if (!headerRegex.test(content)) {
    const sep = content.endsWith('\n') || !content ? '' : '\n';
    content += `${sep}\n${block}`;
    writeText(configPath, content);
    return;
  }

  // Replace existing block until next table header or EOF.
  const sectionRegex = /\[mcp_servers\.seens_notify\][\s\S]*?(?=\n\[[^\]]+\]|$)/m;
  const next = content.replace(sectionRegex, block.trimEnd());
  writeText(configPath, next.endsWith('\n') ? next : `${next}\n`);
}

function installCodex() {
  const codexSkillDest = path.join(CODEX_DIR, 'skills', 'seens-notify', 'SKILL.md');
  const codexMcpDest = path.join(CODEX_DIR, 'seens-notify-mcp.js');
  const codexConfigPath = path.join(CODEX_DIR, 'config.toml');
  const codexAgentsPath = path.join(CODEX_DIR, 'AGENTS.md');

  writeText(codexSkillDest, buildCodexSkillMarkdown());
  copyFile(MCP_SRC, codexMcpDest);
  upsertCodexMcpServer(codexConfigPath, codexMcpDest);
  setInstructionDirectives(codexAgentsPath, 'mcp__seens_notify__notify');

  console.log(`✓ Codex skill installed: ${codexSkillDest}`);
  console.log(`✓ Codex MCP server installed: ${codexMcpDest}`);
  console.log(`✓ Codex MCP registered: ${codexConfigPath}`);
  console.log(`✓ Codex completion directive updated: ${codexAgentsPath}`);
}

function main() {
  if (!fs.existsSync(SKILL_SRC_MD)) {
    throw new Error(`Missing skill source: ${SKILL_SRC_MD}`);
  }
  if (!fs.existsSync(MCP_SRC)) {
    throw new Error(`Missing MCP source: ${MCP_SRC}`);
  }

  installClaude();
  installCodex();

  console.log('\n✓ Done. Restart Claude Code and Codex to load global skill + MCP updates.');
}

main();
