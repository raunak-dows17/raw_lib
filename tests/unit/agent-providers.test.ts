import { describe, expect, it } from "vitest";
import { anthropic, ollama, openai } from "../../src/agent/providers";

type Call = { url: string; init: RequestInit };

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  };

  return { calls, fetch: fetch as typeof globalThis.fetch };
}

const tools = [
  {
    name: "query",
    description: "Run a query",
    parameters: { type: "object", properties: { op: { type: "string" } } },
  },
];

const history = [
  { role: "user" as const, content: "How many users?" },
  {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "c1", name: "query", arguments: { query: { op: "count" } } }],
  },
  {
    role: "tool" as const,
    name: "query",
    toolCallId: "c1",
    content: '{"ok":true,"data":3}',
  },
];

describe("openai adapter", () => {
  it("sends tools and history, then parses tool calls", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    { id: "c2", function: { name: "query", arguments: '{"query":{"op":"list"}}' } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 20, completion_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const model = openai({ apiKey: "key", model: "test-model", fetch });

    const result = await model.generate({ system: "system", messages: history, tools });

    expect(model.id).toBe("openai:test-model");
    expect(result.toolCalls?.[0]).toEqual({
      id: "c2",
      name: "query",
      arguments: '{"query":{"op":"list"}}',
    });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10 });

    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer key");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("test-model");
    expect(body.temperature).toBe(0);
    expect(body.tools[0].function.name).toBe("query");
    expect(body.messages[0]).toEqual({ role: "system", content: "system" });
    expect(body.messages[1]).toEqual({ role: "user", content: "How many users?" });
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"query":{"op":"count"}}');
    expect(body.messages[3]).toEqual({
      role: "tool",
      content: '{"ok":true,"data":3}',
      tool_call_id: "c1",
    });
  });

  it("returns text answers and reports HTTP failures", async () => {
    const answer = openai({
      apiKey: "key",
      fetch: fakeFetch(
        () =>
          new Response(JSON.stringify({ choices: [{ message: { content: "There are 3." } }] }), {
            status: 200,
          }),
      ).fetch,
    });

    await expect(
      answer.generate({ system: "s", messages: [{ role: "user", content: "q" }], tools }),
    ).resolves.toMatchObject({ text: "There are 3." });

    const failing = openai({
      apiKey: "key",
      fetch: fakeFetch(() => new Response("bad key", { status: 401 })).fetch,
    });

    await expect(
      failing.generate({ system: "s", messages: [{ role: "user", content: "q" }], tools }),
    ).rejects.toThrow(/401/);
  });
});

describe("anthropic adapter", () => {
  it("maps messages to blocks and parses tool use", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "Let me check." },
              { type: "tool_use", id: "tu1", name: "query", input: { query: { op: "count" } } },
            ],
            usage: { input_tokens: 30, output_tokens: 15 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const model = anthropic({ apiKey: "key", model: "claude-test", fetch });

    const result = await model.generate({ system: "system", messages: history, tools });

    expect(model.id).toBe("anthropic:claude-test");
    expect(result.text).toBe("Let me check.");
    expect(result.toolCalls?.[0]).toEqual({
      id: "tu1",
      name: "query",
      arguments: { query: { op: "count" } },
    });
    expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 15 });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.system).toBe("system");
    expect(body.max_tokens).toBe(1_024);
    expect(body.tools[0].input_schema.type).toBe("object");
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "How many users?" }],
    });
    expect(body.messages[1].content[0].type).toBe("tool_use");
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "c1", content: '{"ok":true,"data":3}' }],
    });
  });

  it("reports API errors", async () => {
    const model = anthropic({
      apiKey: "key",
      fetch: fakeFetch(
        () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 }),
      ).fetch,
    });

    await expect(
      model.generate({ system: "s", messages: [{ role: "user", content: "q" }], tools }),
    ).rejects.toThrow(/overloaded/);
  });
});

describe("ollama adapter", () => {
  it("uses the local chat API and parses tool calls", async () => {
    const { calls, fetch } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            message: {
              content: "",
              tool_calls: [{ function: { name: "query", arguments: { query: { op: "list" } } } }],
            },
            prompt_eval_count: 12,
            eval_count: 4,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const model = ollama({ model: "llama3.1", fetch });

    const result = await model.generate({ system: "system", messages: history, tools });

    expect(calls[0]?.url).toBe("http://localhost:11434/api/chat");
    expect(result.toolCalls?.[0]).toMatchObject({
      name: "query",
      arguments: { query: { op: "list" } },
    });
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 4 });

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.stream).toBe(false);
    expect(body.messages[2].tool_calls[0].function.name).toBe("query");
  });

  it("reports connection and payload errors", async () => {
    const failing = ollama({
      fetch: fakeFetch(() => new Response("offline", { status: 500 })).fetch,
    });

    await expect(
      failing.generate({ system: "s", messages: [{ role: "user", content: "q" }], tools }),
    ).rejects.toThrow(/500/);

    const payloadError = ollama({
      fetch: fakeFetch(
        () => new Response(JSON.stringify({ error: "model not found" }), { status: 200 }),
      ).fetch,
    });

    await expect(
      payloadError.generate({ system: "s", messages: [{ role: "user", content: "q" }], tools }),
    ).rejects.toThrow(/model not found/);
  });
});
