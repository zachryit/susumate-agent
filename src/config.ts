// Config + env loading. Secrets come from .env. State/media dirs resolve to repo-relative
// paths unless overridden. The model provider is selected by the model ref's provider part
// (qwen/…, gemini/…, openai/…) against the provider registry.

import 'dotenv/config';
import { resolve } from 'node:path';
import { resolveModel, type ChatModel, type ProviderSpec } from './agent/model.js';

export interface AgentConfig {
  providers: Record<string, ProviderSpec>;
  modelPrimary: string;
  modelFallbacks: string[];

  susumateApiUrl: string;
  susumateTimeoutMs: number;

  wa: {
    accountId: string;
    authDir: string;
    mediaDir: string;
    printQr: boolean;
    pairNumber?: string;
    mediaMaxBytes: number;
    qrPngPath: string;
  };

  maxTurns: number;
  userDailyLimit: number;
  guestDailyLimit: number;
  debounceMs: number;
  maxHistory: number;

  sessionStore: string;
  sessionEncKey: string;

  httpPort: number;
  logDir: string;
  currency: string;
}

const ROOT = resolve(process.cwd());

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) ? v : fallback;
}

// Every provider is reached through the same OpenAI-compatible client; they differ only by
// base URL + API key (+ Qwen's enable_thinking reasoning style).
function buildProviders(): Record<string, ProviderSpec> {
  return {
    qwen: {
      baseUrl: process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      apiKey: process.env.DASHSCOPE_API_KEY ?? '',
      thinking: 'qwen',
    },
    gemini: {
      baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: process.env.GEMINI_API_KEY ?? '',
      thinking: 'none',
    },
    openai: {
      baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: process.env.OPENAI_API_KEY ?? '',
      thinking: 'none',
    },
  };
}

export function loadConfig(): AgentConfig {
  const stateDir = resolve(process.env.WA_STATE_DIR ?? `${ROOT}/sessions/wa`);
  const mediaDir = resolve(process.env.WA_MEDIA_DIR ?? `${ROOT}/sessions/media`);
  return {
    providers: buildProviders(),
    modelPrimary: process.env.AGENT_MODEL_PRIMARY ?? 'qwen/qwen-max',
    modelFallbacks: (process.env.AGENT_MODEL_FALLBACKS ?? 'qwen/qwen-plus')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),

    susumateApiUrl: (process.env.SUSUMATE_API_URL ?? 'http://127.0.0.1:8000/api').replace(/\/+$/, ''),
    susumateTimeoutMs: num('SUSUMATE_API_TIMEOUT_MS', 30000),

    wa: {
      accountId: process.env.WA_ACCOUNT_ID ?? 'default',
      authDir: stateDir,
      mediaDir,
      printQr: (process.env.WA_PRINT_QR ?? 'true').toLowerCase() !== 'false',
      pairNumber: process.env.WA_PAIR_NUMBER || undefined,
      mediaMaxBytes: num('WA_MEDIA_MAX_BYTES', 20 * 1024 * 1024),
      qrPngPath: resolve(`${stateDir}/pair-qr.png`),
    },

    maxTurns: num('AGENT_MAX_TURNS', 6),
    userDailyLimit: num('AGENT_USER_DAILY_LIMIT', 60),
    guestDailyLimit: num('AGENT_GUEST_DAILY_LIMIT', 20),
    debounceMs: num('AGENT_DEBOUNCE_MS', 1500),
    maxHistory: num('AGENT_MAX_HISTORY', 24),

    sessionStore: resolve(process.env.SESSION_STORE ?? `${ROOT}/sessions/store.json`),
    sessionEncKey: process.env.SESSION_ENC_KEY ?? '',

    httpPort: num('HTTP_PORT', 8787),
    logDir: resolve(process.env.LOG_DIR ?? `${ROOT}/logs`),
    currency: process.env.CURRENCY ?? 'GHS',
  };
}

export function primaryModel(cfg: AgentConfig): ChatModel {
  return resolveModel(cfg.modelPrimary, cfg.providers);
}

export function fallbackModels(cfg: AgentConfig): ChatModel[] {
  return cfg.modelFallbacks
    .map((r) => {
      try {
        return resolveModel(r, cfg.providers);
      } catch {
        return null;
      }
    })
    .filter((m): m is ChatModel => m !== null);
}
