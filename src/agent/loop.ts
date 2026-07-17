// The agent turn loop. prompt -> LLM -> tool calls? execute & loop :
// final reply. Seams: beforeToolCall (allowlist veto), afterToolCall, prepareNextTurn (silent
// model fallback on error).

import type { AgentTool, AssistantMessage, Message, ToolCall, ToolExecResult } from './types.js';
import type { ChatModel } from './model.js';
import type { ChatProvider, ToolChoice } from './provider.js';

export interface LoopEvent {
  type: 'turn_start' | 'assistant' | 'tool_call' | 'tool_result' | 'fallback' | 'final';
  detail?: unknown;
}

export interface RunTurnConfig {
  provider: ChatProvider;
  model: ChatModel;
  systemPrompt: string;
  messages: Message[];
  tools: AgentTool[];
  maxTurns?: number;
  signal?: AbortSignal;
  beforeToolCall?: (x: { call: ToolCall; tool: AgentTool }) => Promise<{ block: boolean; reason?: string } | void>;
  afterToolCall?: (x: { call: ToolCall; result: ToolExecResult }) => Promise<ToolExecResult | void>;
  prepareNextTurn?: (x: { error?: unknown; model: ChatModel }) => Promise<{ model: ChatModel } | void>;
  toolChoiceFirstTurn?: ToolChoice;
  onEvent?: (e: LoopEvent) => void;
}

export async function runTurn(cfg: RunTurnConfig): Promise<AssistantMessage> {
  const maxTurns = cfg.maxTurns ?? 6;
  const toolsByName = new Map(cfg.tools.map((t) => [t.name, t]));
  let model = cfg.model;

  for (let turn = 0; turn < maxTurns; turn++) {
    cfg.onEvent?.({ type: 'turn_start', detail: { turn, model: model.ref } });

    let assistant: AssistantMessage;
    try {
      assistant = await cfg.provider.complete(
        model,
        { systemPrompt: cfg.systemPrompt, messages: cfg.messages, tools: cfg.tools },
        {
          signal: cfg.signal,
          thinking: model.enableThinking,
          toolChoice: turn === 0 ? (cfg.toolChoiceFirstTurn ?? 'auto') : 'auto',
        },
      );
    } catch (error) {
      const upd = await cfg.prepareNextTurn?.({ error, model });
      if (upd?.model && upd.model.ref !== model.ref) {
        cfg.onEvent?.({ type: 'fallback', detail: { from: model.ref, to: upd.model.ref } });
        model = upd.model; // silent fallback — no user-facing notice
        continue;
      }
      throw error;
    }

    cfg.messages.push(assistant);
    cfg.onEvent?.({ type: 'assistant', detail: { content: assistant.content, toolCalls: assistant.toolCalls.length } });

    if (assistant.toolCalls.length === 0) {
      cfg.onEvent?.({ type: 'final', detail: { content: assistant.content } });
      return assistant;
    }

    for (const call of assistant.toolCalls) {
      cfg.onEvent?.({ type: 'tool_call', detail: { name: call.name, args: call.arguments } });
      const tool = toolsByName.get(call.name);
      let result: ToolExecResult;

      if (!tool) {
        result = { content: JSON.stringify({ error: 'unknown_tool', tool: call.name }), isError: true };
      } else {
        const veto = await cfg.beforeToolCall?.({ call, tool });
        if (veto?.block) {
          result = { content: JSON.stringify({ error: 'blocked', reason: veto.reason }), isError: true };
        } else {
          try {
            result = await tool.execute(call.arguments, cfg.signal);
          } catch (err) {
            result = { content: JSON.stringify({ error: 'tool_failed', message: String(err) }), isError: true };
          }
          result = (await cfg.afterToolCall?.({ call, result })) ?? result;
        }
      }

      cfg.onEvent?.({ type: 'tool_result', detail: { name: call.name, isError: result.isError } });
      cfg.messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
      });
    }
  }

  const last = [...cfg.messages].reverse().find((m): m is AssistantMessage => m.role === 'assistant');
  return last ?? { role: 'assistant', content: '', toolCalls: [] };
}
