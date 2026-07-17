// The Mate turn: wraps the generic agent loop with login/quota checks, guardrails, and per-user session handling
// with SusuMate's behaviors — logout intent, daily quota, guest/user tool routing, and the
// egress guardrails (scrub + act-never-pretend).

import type { AgentConfig } from '../config.js';
import type { ChatProvider } from './provider.js';
import type { ChatModel } from './model.js';
import type { Message } from './types.js';
import type { SusumateClient } from '../susumate/client.js';
import type { SessionStore, Session } from '../sessions/store.js';
import { runTurn } from './loop.js';
import { buildTools, allToolNames, type TurnState } from './tools.js';
import { buildSystemPrompt, isLogoutIntent } from './prompt.js';
import { scrub, enforceHonesty } from './guardrails.js';

export interface MateDeps {
  cfg: AgentConfig;
  provider: ChatProvider;
  model: ChatModel;
  fallbacks: ChatModel[];
  client: SusumateClient;
  store: SessionStore;
}

export interface MateInput {
  session: Session;
  userMessage: string;
  groupContext: boolean;
  chatTail?: string[];
  signal?: AbortSignal;
}

const SCRUB_NAMES = allToolNames();

export async function runMateTurn(deps: MateDeps, input: MateInput): Promise<string> {
  const { store } = deps;
  const { session } = input;

  // "Log out" clears the conversation + token before anything else — works even without an LLM key.
  if (!input.groupContext && isLogoutIntent(input.userMessage)) {
    store.clear(session);
    return "Done — I've signed you out and cleared our chat. Say hi whenever you want to start again. 👋";
  }

  const today = new Date().toISOString().slice(0, 10);
  const limit = store.isSignedIn(session) ? deps.cfg.userDailyLimit : deps.cfg.guestDailyLimit;
  if (!store.withinQuota(session, limit, today)) {
    return "I've hit my chat limit with you for today — try again tomorrow, or use the app buttons for anything urgent.";
  }

  const state: TurnState = { writeToolSucceeded: false, signedInThisTurn: false };
  const tools = buildTools({
    client: deps.client,
    store,
    session,
    groupContext: input.groupContext,
    boundParams: {},
    state,
  });

  const systemPrompt = buildSystemPrompt({
    signedIn: store.isSignedIn(session),
    userName: session.userName,
    groupContext: input.groupContext,
    today,
    currency: deps.cfg.currency,
    chatTail: input.chatTail,
  });

  // Work on a copy of history; only the final user/assistant text is persisted on success.
  const messages: Message[] = [...session.history, { role: 'user', content: input.userMessage }];

  let modelIdx = -1; // -1 = primary; 0.. = fallbacks
  try {
    const assistant = await runTurn({
      provider: deps.provider,
      model: deps.model,
      systemPrompt,
      messages,
      tools,
      maxTurns: deps.cfg.maxTurns,
      signal: input.signal,
      prepareNextTurn: async () => {
        const next = deps.fallbacks[modelIdx + 1];
        if (next) {
          modelIdx += 1;
          return { model: next };
        }
        return undefined;
      },
    });

    let text = assistant.content?.trim() || 'Okay!';
    text = enforceHonesty(text, state.writeToolSucceeded);
    text = scrub(text, SCRUB_NAMES);

    store.remember(session, input.userMessage, text);
    return text;
  } catch (e) {
    console.error('[mate] turn failed', (e as Error)?.message ?? e);
    return "Sorry — I couldn't finish that just now. Please try again, or use the app buttons.";
  }
}
