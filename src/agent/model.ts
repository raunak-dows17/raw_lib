import type { AgentModel, AgentModelInput, AgentModelResult, AgentToolCall } from "./types";

export type MockModelStep =
  | AgentModelResult
  | ((input: AgentModelInput) => AgentModelResult | Promise<AgentModelResult>);

export type MockModelOptions = {
  id?: string;
  /** Repeat the last scripted step once the script is exhausted. */
  repeatLast?: boolean;
  /** Text returned when the script is exhausted and `repeatLast` is false. */
  fallbackText?: string;
};

/**
 * Deterministic model for tests, CI, and the zero-setup demo. It never performs I/O; each
 * call returns the next scripted turn.
 */
export function mockModel(steps: MockModelStep[], options: MockModelOptions = {}): AgentModel {
  let index = 0;

  return {
    id: options.id ?? "mock",
    async generate(input) {
      if (index >= steps.length) {
        if (options.repeatLast && steps.length > 0) {
          const last = steps[steps.length - 1] as MockModelStep;
          return typeof last === "function" ? last(input) : last;
        }
        return { text: options.fallbackText ?? "I could not complete that request." };
      }

      const step = steps[index++] as MockModelStep;
      return typeof step === "function" ? step(input) : step;
    },
  };
}

/** Convenience constructor for a single tool-call turn. */
export function callTool(
  name: string,
  args: Record<string, unknown>,
  options: { id?: string; usage?: AgentModelResult["usage"] } = {},
): AgentModelResult {
  const call: AgentToolCall = {
    id: options.id ?? `call_${name}`,
    name,
    arguments: args,
  };

  return {
    toolCalls: [call],
    ...(options.usage ? { usage: options.usage } : {}),
  };
}

/** Convenience constructor for a final answer turn. */
export function answer(text: string, usage?: AgentModelResult["usage"]): AgentModelResult {
  return { text, ...(usage ? { usage } : {}) };
}
