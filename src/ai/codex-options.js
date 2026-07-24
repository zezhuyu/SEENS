export const DEFAULT_CODEX_REASONING_EFFORT = 'low';

const SUPPORTED_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

export function codexReasoningEffort(env = process.env) {
  const configured = env.CODEX_REASONING_EFFORT?.trim().toLowerCase();
  return SUPPORTED_REASONING_EFFORTS.has(configured)
    ? configured
    : DEFAULT_CODEX_REASONING_EFFORT;
}

export function codexReasoningArgs(env = process.env) {
  return ['-c', `model_reasoning_effort=${JSON.stringify(codexReasoningEffort(env))}`];
}

export function codexFastModeArgs(env = process.env) {
  if (env.CODEX_FAST_MODE === '0') return [];
  return ['-c', 'service_tier="fast"', '-c', 'features.fast_mode=true'];
}
