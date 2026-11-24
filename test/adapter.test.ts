import { afterEach, describe, expect, it, vi } from "vitest";
import { fromOpenAIToolCalls, openAICompatible, toOpenAIMessages } from "../examples/adapters/openai-compatible.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI-compatible adapter", () => {
  it("sends tools, tool choice, tool calls and tool results in OpenAI's shape", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return Response.json({
        model: "m",
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "c2", type: "function", function: { name: "weather", arguments: '{"city":"上海"}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    });
    const model = openAICompatible({ baseURL: "http://x/v1", model: "m" });
    const response = await model.complete(
      {
        messages: [
          { role: "user", content: "天气" },
          { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "weather", arguments: { city: "南京" } }] },
          { role: "tool", toolCallId: "c1", content: "晴" },
        ],
        tools: [{ name: "weather", description: "Weather", inputSchema: { type: "object" } }],
        toolChoice: { name: "weather" },
      },
      { signal: new AbortController().signal },
    );
    expect(body.tools).toEqual([
      { type: "function", function: { name: "weather", description: "Weather", parameters: { type: "object" } } },
    ]);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "weather" } });
    expect(body.messages).toEqual([
      { role: "user", content: "天气" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"南京"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "晴" },
    ]);
    expect(response).toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c2", name: "weather", arguments: { city: "上海" } }],
    });
  });

  it("marks arguments it cannot read instead of guessing", () => {
    expect(
      fromOpenAIToolCalls([
        { id: "a", function: { name: "t", arguments: "{not json" } },
        { id: "b", function: { name: "t", arguments: "[1]" } },
        { function: { name: "t", arguments: "" } },
      ]),
    ).toEqual([
      { id: "a", name: "t", arguments: {}, parseError: "arguments are not valid JSON" },
      { id: "b", name: "t", arguments: {}, parseError: "arguments are not a JSON object" },
      { id: "call_2", name: "t", arguments: {} },
    ]);
    expect(toOpenAIMessages([{ role: "system", content: "s" }])).toEqual([{ role: "system", content: "s" }]);
  });
});
