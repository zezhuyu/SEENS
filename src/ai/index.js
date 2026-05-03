/**
 * AI Agent factory — switch between Claude and Codex at runtime.
 *
 * Active agent is determined by:
 *   1. state.db prefs key "ai.agent"  (runtime override via POST /api/settings/agent)
 *   2. AI_AGENT env var               (startup default)
 *   3. Fallback: "claude"
 *
 * Both agents expose the same interface:
 *   generate(systemPrompt: string, userMessage: string)
 *     → Promise<{ say, play: [{title, artist, source}], reason, segue }>
 */

import * as claude from './claude.js';
import * as codex from './codex.js';
import { getPref } from '../state.js';

const AGENTS = { claude, codex };

export const AGENT_NAMES = Object.keys(AGENTS);

export function getActiveAgent() {
  const name = getPref('ai.agent', null) ?? process.env.AI_AGENT ?? 'claude';
  const key = name.toLowerCase();
  if (!AGENTS[key]) throw new Error(`Unknown AI agent: "${name}". Valid: ${AGENT_NAMES.join(', ')}`);
  return { name: key, agent: AGENTS[key] };
}

export async function generate(systemPrompt, userMessage) {
  const { agent } = getActiveAgent();
  return agent.generate(systemPrompt, userMessage);
}

export function cancelCurrentCall() {
  try {
    const { agent } = getActiveAgent();
    if (typeof agent.cancelCurrentCall === 'function') agent.cancelCurrentCall();
  } catch {}
}
