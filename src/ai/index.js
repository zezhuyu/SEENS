/**
 * AI entry point.
 *
 * Routes all generate() calls through the long-running AgentProcess.
 * The agent owns all conversation memory — nothing is stored in the SEENS app
 * beyond USER/ (taste, routines, mood-rules).
 *
 * The backend (claude | codex) is chosen by the AgentProcess based on
 * AI_AGENT env var or the ai.agent pref stored in state.db.
 *
 * The old per-request claude.js / codex.js modules are preserved as
 * fallback adapters and for direct testing.
 */

import { agent }    from './AgentClient.js';
import * as claude  from './claude.js';
import * as codex   from './codex.js';
import { getPref }  from '../state.js';

export const AGENT_NAMES = ['claude', 'codex'];

export function getActiveAgentName() {
  return (getPref('ai.agent', null) ?? process.env.AI_AGENT ?? 'claude').toLowerCase();
}

/**
 * Primary generate() — routes through the always-on agent process.
 * Falls back to direct stateless call if agent is not ready.
 */
export async function generate(systemPrompt, userMessage) {
  try {
    return await agent.generate(systemPrompt, userMessage);
  } catch (err) {
    console.warn('[AI] AgentClient failed, falling back to direct call:', err.message);
    const name = getActiveAgentName();
    const backend = name === 'codex' ? codex : claude;
    return backend.generate(systemPrompt, userMessage);
  }
}

/**
 * Agent control helpers — used by /api/settings and test scripts.
 */
export async function agentStatus() {
  return agent.status();
}

export async function agentReset() {
  return agent.reset();
}

/** True when the persistent agent subprocess is alive and ready. */
export function isAgentActive() {
  return agent.isActive();
}
