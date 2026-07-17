// Core message + tool types for the agent loop. A deliberately tiny subset of a full agent
// SDK's model. Passed straight to DashScope (Qwen) function-calling.

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls: ToolCall[];
  reasoning?: string;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

/** Minimal JSON Schema for a tool's parameters. */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolExecResult {
  content: string;
  isError?: boolean;
  details?: unknown;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Marks a write/money action — hidden in group chats, gates the honesty guardrail. */
  sensitive?: boolean;
  /** Safe to expose when Mate is @mentioned in a group chat. */
  groupSafe?: boolean;
  timeoutMs?: number;
  execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolExecResult>;
}
