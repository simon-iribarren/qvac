// @ts-expect-error brittle has no type declarations
import test from "brittle";
import type { Tool } from "@/schemas";
import { parseToolCalls } from "@/server/utils/tool-parser";

const weatherTool: Tool = {
  type: "function",
  name: "weather",
  description: "Weather",
  parameters: {
    type: "object",
    properties: {
      args: { type: "array" },
      timeoutMs: { type: "integer" },
    },
    required: ["args"],
  },
};

const tools: Tool[] = [weatherTool];

test("parseToolCalls: duplicate identical tool_call inside and outside thinking → one", (t) => {
  const assistant = `<redacted_thinking>
<tool_call>
{"name": "weather", "arguments": {"args": ["-s", "https://wttr.in/Curitiba"], "timeoutMs": 3000}}
</tool_call></redacted_thinking>

<tool_call>
{"name": "weather", "arguments": {"args": ["-s", "https://wttr.in/Curitiba"], "timeoutMs": 3000}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(assistant, tools);
  t.is(toolCalls.length, 1);
  t.is(toolCalls[0]?.name, "weather");
});

test("parseToolCalls: tool_call only inside redacted_thinking still runs once", (t) => {
  const assistant = `<redacted_thinking>
<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>
</redacted_thinking>`;

  const { toolCalls } = parseToolCalls(assistant, tools);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments.args, ["London"]);
});

test("parseToolCalls: single tool_call without thinking unchanged", (t) => {
  const assistant = `<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(assistant, tools);
  t.is(toolCalls.length, 1);
  t.alike(toolCalls[0]?.arguments.args, ["Paris"]);
});

test("parseToolCalls: two different weather args are not deduped", (t) => {
  const assistant = `<tool_call>
{"name": "weather", "arguments": {"args": ["London"]}}
</tool_call>
<tool_call>
{"name": "weather", "arguments": {"args": ["Paris"]}}
</tool_call>`;

  const { toolCalls } = parseToolCalls(assistant, tools);
  t.is(toolCalls.length, 2);
});
