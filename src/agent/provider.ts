// Model provider: one OpenAI-compatible client per configured provider —
// DashScope (Qwen), Gemini's OpenAI-compatible endpoint, OpenAI. Always streams; returns a fully
// assembled AssistantMessage. The only provider-specific bit is Qwen's top-level enable_thinking.

import OpenAI from 'openai';
import type { AgentTool, AssistantMessage, Message, ToolCall } from './types.js';
import type { ChatModel } from './model.js';

export type ToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };

export interface CompleteOptions {
  signal?: AbortSignal;
  thinking?: boolean;
  toolChoice?: ToolChoice;
}

interface PartialToolCall {
  id: string;
  name: string;
  argChunks: string[];
}

export class ChatProvider {
  private clients = new Map<string, OpenAI>();

  private clientFor(model: ChatModel): OpenAI {
    const key = `${model.baseUrl} ${model.apiKey}`;
    let client = this.clients.get(key);
    if (!client) {
      if (!model.apiKey) throw new Error(`no API key for provider '${model.provider}'`);
      client = new OpenAI({ apiKey: model.apiKey, baseURL: model.baseUrl });
      this.clients.set(key, client);
    }
    return client;
  }

  async complete(
    model: ChatModel,
    ctx: { systemPrompt: string; messages: Message[]; tools: AgentTool[] },
    opts: CompleteOptions = {},
  ): Promise<AssistantMessage> {
    const params: Record<string, unknown> = {
      model: model.id,
      messages: toChatMessages(ctx.systemPrompt, ctx.messages),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: model.maxTokens,
    };
    if (ctx.tools.length) {
      params.tools = toChatTools(ctx.tools);
      params.tool_choice = opts.toolChoice ?? 'auto';
    }
    if (model.thinking === 'qwen') params.enable_thinking = opts.thinking ?? model.enableThinking;

    const stream = await this.clientFor(model).chat.completions.create(params as never, { signal: opts.signal });

    let content = '';
    let reasoning = '';
    const partial = new Map<number, PartialToolCall>();

    // @ts-expect-error - streamed response is async-iterable
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta as
        | { content?: string | null; reasoning_content?: string | null; tool_calls?: unknown[] }
        | undefined;
      if (!delta) continue;
      if (delta.content) content += delta.content;
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>) {
          const slot = partial.get(tc.index) ?? { id: '', name: '', argChunks: [] };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.argChunks.push(tc.function.arguments);
          partial.set(tc.index, slot);
        }
      }
    }

    const toolCalls: ToolCall[] = [...partial.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, p]) => ({
        id: p.id || `call_${p.name}`,
        name: p.name,
        arguments: safeParseArgs(p.argChunks.join('')),
      }));

    return { role: 'assistant', content, toolCalls, reasoning: reasoning || undefined };
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toChatMessages(systemPrompt: string, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

function toChatTools(tools: AgentTool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
