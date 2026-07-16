// Model references + provider registry (ported from swimbot). A model ref is `provider/model`
// (e.g. qwen/qwen-max). Every provider is reached through one OpenAI-compatible client; they
// differ only by base URL, API key, and reasoning style. Qwen is the default provider.

export type ThinkingStyle = 'qwen' | 'none';

export interface ProviderSpec {
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingStyle;
}

export interface ChatModel {
  ref: string;
  provider: string;
  id: string;
  baseUrl: string;
  apiKey: string;
  thinking: ThinkingStyle;
  enableThinking: boolean;
  contextWindow: number;
  maxTokens: number;
}

export interface ModelOverrides {
  enableThinking?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

const DEFAULT_PROVIDER = 'qwen';

/** Parse `provider/model`; a ref with no slash uses the default provider. */
export function parseRef(ref: string): { provider: string; id: string } {
  const i = ref.indexOf('/');
  if (i === -1) return { provider: DEFAULT_PROVIDER, id: ref };
  return { provider: ref.slice(0, i), id: ref.slice(i + 1) };
}

export function resolveModel(
  ref: string,
  providers: Record<string, ProviderSpec>,
  overrides: ModelOverrides = {},
): ChatModel {
  const { provider, id } = parseRef(ref);
  const spec = providers[provider];
  if (!spec) {
    const known = Object.keys(providers).join(', ') || '(none configured)';
    throw new Error(`unknown model provider '${provider}' in ref '${ref}'. Configured providers: ${known}`);
  }
  if (!spec.apiKey) {
    throw new Error(`no API key configured for provider '${provider}' — set its API key in .env (ref '${ref}')`);
  }
  return {
    ref,
    provider,
    id,
    baseUrl: spec.baseUrl,
    apiKey: spec.apiKey,
    thinking: spec.thinking,
    enableThinking: overrides.enableThinking ?? false,
    contextWindow: overrides.contextWindow ?? 32768,
    maxTokens: overrides.maxTokens ?? 8192,
  };
}
