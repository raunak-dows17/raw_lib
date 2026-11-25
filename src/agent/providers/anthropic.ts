import { RawLibError } from "../../core/errors";
import type { AgentModel, AgentModelInput, AgentModelResult, AgentToolCall } from "../types";

export type AnthropicOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
};

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

type AnthropicMessage = { role: "user" | "assistant"; content: Block[] };

type AnthropicResponse = {
  content?: (
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input?: Record<string, unknown> }
  )[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
};

/** Anthropic Messages adapter with native tool use. */
export function anthropic(options: AnthropicOptions): AgentModel {
  const send = options.fetch ?? globalThis.fetch;
  const model = options.model ?? "claude-sonnet-4-5";
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com/v1").replace(/\/$/, "");

  return {
    id: `anthropic:${model}`,
    async generate(input: AgentModelInput): Promise<AgentModelResult> {
      if (typeof send !== "function") {
        throw new RawLibError("INTERNAL_ERROR", "fetch is not available in this runtime");
      }

      const response = await send(`${baseUrl}/messages`, {
        method: "POST",
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          model,
          max_tokens: options.maxTokens ?? 1_024,
          temperature: options.temperature ?? 0,
          system: input.system,
          messages: toMessages(input),
          tools: input.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.parameters,
          })),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const payload = (await response.json().catch(() => ({}))) as AnthropicResponse;

      if (!response.ok) {
        throw new RawLibError(
          "ADAPTER_ERROR",
          `Anthropic responded with ${response.status}${
            payload.error?.message ? `: ${payload.error.message}` : ""
          }`,
        );
      }

      const text = (payload.content ?? [])
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      const toolCalls: AgentToolCall[] = (payload.content ?? [])
        .filter(
          (
            block,
          ): block is {
            type: "tool_use";
            id: string;
            name: string;
            input?: Record<string, unknown>;
          } => block.type === "tool_use",
        )
        .map((block) => ({
          id: block.id,
          name: block.name,
          arguments: block.input ?? {},
        }));

      return {
        ...(text ? { text } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          inputTokens: payload.usage?.input_tokens ?? 0,
          outputTokens: payload.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

function toMessages(input: AgentModelInput): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];

  for (const message of input.messages) {
    if (message.role === "assistant") {
      const blocks: Block[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        });
      }
      push(messages, "assistant", blocks);
      continue;
    }

    if (message.role === "tool") {
      push(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId ?? message.name ?? "unknown",
          content: message.content,
        },
      ]);
      continue;
    }

    push(messages, "user", [{ type: "text", text: message.content }]);
  }

  return messages;
}

function push(messages: AnthropicMessage[], role: "user" | "assistant", blocks: Block[]): void {
  const last = messages[messages.length - 1];
  if (last && last.role === role) {
    last.content.push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function parseArguments(value: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
