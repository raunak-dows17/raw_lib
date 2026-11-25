import { RawLibError } from "../../core/errors";
import type { AgentModel, AgentModelInput, AgentModelResult, AgentToolCall } from "../types";

export type OpenAIOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
};

type OpenAITool = {
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAITool[] }
  | { role: "tool"; content: string; tool_call_id: string };

type OpenAIResponse = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** OpenAI Chat Completions adapter with native function calling. */
export function openai(options: OpenAIOptions): AgentModel {
  const send = options.fetch ?? globalThis.fetch;
  const model = options.model ?? "gpt-4.1-mini";
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

  return {
    id: `openai:${model}`,
    async generate(input: AgentModelInput): Promise<AgentModelResult> {
      if (typeof send !== "function") {
        throw new RawLibError("INTERNAL_ERROR", "fetch is not available in this runtime");
      }

      const response = await send(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          ...(options.headers ?? {}),
        },
        body: JSON.stringify({
          model,
          temperature: options.temperature ?? 0,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
          messages: toMessages(input),
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: "auto",
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new RawLibError(
          "ADAPTER_ERROR",
          `OpenAI responded with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        );
      }

      const payload = (await response.json()) as OpenAIResponse;
      const message = payload.choices?.[0]?.message;
      const toolCalls: AgentToolCall[] = (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      }));

      return {
        ...(message?.content ? { text: message.content } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

function toMessages(input: AgentModelInput): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: "system", content: input.system }];

  for (const message of input.messages) {
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content || null,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                type: "function" as const,
                function: {
                  name: call.name,
                  arguments:
                    typeof call.arguments === "string"
                      ? call.arguments
                      : JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "tool",
        content: message.content,
        tool_call_id: message.toolCallId ?? message.name ?? "unknown",
      });
      continue;
    }

    messages.push({ role: "user", content: message.content });
  }

  return messages;
}
