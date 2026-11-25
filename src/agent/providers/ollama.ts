import { RawLibError } from "../../core/errors";
import type { AgentModel, AgentModelInput, AgentModelResult, AgentToolCall } from "../types";

export type OllamaOptions = {
  model?: string;
  baseUrl?: string;
  temperature?: number;
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
};

type OllamaMessage =
  | { role: "system" | "user" | "tool"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
    };

type OllamaResponse = {
  message?: {
    content?: string;
    tool_calls?: { function: { name: string; arguments?: Record<string, unknown> } }[];
  };
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

/** Local Ollama adapter. No API key; useful for offline demos. */
export function ollama(options: OllamaOptions = {}): AgentModel {
  const send = options.fetch ?? globalThis.fetch;
  const model = options.model ?? "llama3.1";
  const baseUrl = (options.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");

  return {
    id: `ollama:${model}`,
    async generate(input: AgentModelInput): Promise<AgentModelResult> {
      if (typeof send !== "function") {
        throw new RawLibError("INTERNAL_ERROR", "fetch is not available in this runtime");
      }

      const response = await send(`${baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options.headers ?? {}) },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: options.temperature ?? 0 },
          messages: toMessages(input),
          tools: input.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new RawLibError(
          "ADAPTER_ERROR",
          `Ollama responded with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
        );
      }

      const payload = (await response.json()) as OllamaResponse;
      if (payload.error) throw new RawLibError("ADAPTER_ERROR", payload.error);

      const toolCalls: AgentToolCall[] = (payload.message?.tool_calls ?? []).map((call, index) => ({
        id: `ollama_${index}`,
        name: call.function.name,
        arguments: call.function.arguments ?? {},
      }));

      return {
        ...(payload.message?.content ? { text: payload.message.content } : {}),
        ...(toolCalls.length > 0 ? { toolCalls } : {}),
        usage: {
          inputTokens: payload.prompt_eval_count ?? 0,
          outputTokens: payload.eval_count ?? 0,
        },
      };
    },
  };
}

function toMessages(input: AgentModelInput): OllamaMessage[] {
  const messages: OllamaMessage[] = [{ role: "system", content: input.system }];

  for (const message of input.messages) {
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: message.content,
        ...(message.toolCalls && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                function: {
                  name: call.name,
                  arguments:
                    typeof call.arguments === "string"
                      ? parseArguments(call.arguments)
                      : call.arguments,
                },
              })),
            }
          : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      messages.push({ role: "tool", content: message.content });
      continue;
    }

    messages.push({ role: "user", content: message.content });
  }

  return messages;
}

function parseArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
