/**
 * Agentic Tools Example — Reference Implementation
 *
 * Demonstrates the full agentic tool-calling pattern with anchored tools:
 * - Multi-round tool chains (model calls tool → gets result → calls next tool)
 * - Thinking kept during chain for KV cache compatibility
 * - History cleanup after chain completes
 * - Follow-up turns with clean history
 *
 * Run: bun run examples/agentic-tools.ts
 */

import { z } from "zod"
import {
  completion,
  loadModel,
  unloadModel,
  type ToolInput,
  QWEN3_1_7B_INST_Q4,
} from "@qvac/sdk"

// ─── Tool Definitions ────────────────────────────────────────────────────────

const weatherSchema = z.object({
  location: z.string().describe("City name, e.g. 'Paris' or 'Tokyo'"),
  unit: z.string().optional().describe("Temperature unit: celsius or fahrenheit"),
})

const searchSchema = z.object({
  query: z.string().describe("Search query"),
})

const stockSchema = z.object({
  symbol: z.string().describe("Stock ticker symbol, e.g. 'AAPL'"),
})

const weatherTool: ToolInput = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: weatherSchema,
}

const searchTool: ToolInput = {
  name: "search_web",
  description: "Search the web for information",
  parameters: searchSchema,
}

const stockTool: ToolInput = {
  name: "get_stock_price",
  description: "Get the current stock price for a ticker symbol",
  parameters: stockSchema,
}

// ─── Simulated Tool Executor ─────────────────────────────────────────────────

function executeToolCall(name: string, args: Record<string, string>): string {
  const query = String(args["query"] ?? "").toLowerCase()

  if (name === "get_weather") {
    return JSON.stringify({
      temperature: 18,
      condition: "Partly cloudy",
      humidity: 65,
      location: args["location"],
      unit: args["unit"] ?? "celsius",
    })
  }

  if (name === "search_web") {
    if (query.includes("nexora") && (query.includes("ceo") || query.includes("founder") || query.includes("leader"))) {
      return JSON.stringify({
        results: [{
          title: "Nexora Technologies Leadership",
          snippet: "Dr. Elena Voss is the CEO and co-founder of Nexora Technologies. She founded the company in 2019 and leads its edge computing division.",
        }],
      })
    }
    if (query.includes("elena voss") || query.includes("voss")) {
      return JSON.stringify({
        results: [{
          title: "Dr. Elena Voss - Profile",
          snippet: "Dr. Elena Voss was born and raised in Ljubljana, Slovenia. She is known for her work in edge AI.",
        }],
      })
    }
    if (query.includes("nexora")) {
      return JSON.stringify({
        results: [{
          title: "Nexora Technologies - About Us",
          snippet: "Nexora Technologies is a Swiss AI company headquartered in Zurich, Switzerland. Founded in 2019, the company specializes in edge computing solutions.",
        }],
      })
    }
    return JSON.stringify({
      results: [{
        title: `Results for: ${args["query"]}`,
        snippet: `Information about ${args["query"]}. This is a simulated search result.`,
      }],
    })
  }

  if (name === "get_stock_price") {
    return JSON.stringify({
      symbol: args["symbol"],
      price: 178.52,
      change: "+1.2%",
      currency: "USD",
    })
  }

  return JSON.stringify({ error: `Unknown tool: ${name}` })
}

// ─── Tool Call Parser ────────────────────────────────────────────────────────

interface ParsedToolCall {
  name: string
  arguments: Record<string, string>
}

function parseToolCalls(text: string): ParsedToolCall[] {
  const pattern = /<tool_call>\s*(\{.*?\})\s*<\/tool_call>/gs
  const calls: ParsedToolCall[] = []

  let match
  while ((match = pattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1] ?? "{}") as { name: string; arguments?: Record<string, string> }
      calls.push({
        name: parsed.name,
        arguments: parsed.arguments ?? {},
      })
    } catch {
      // skip malformed JSON
    }
  }
  return calls
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
}

// ─── Agentic Loop ────────────────────────────────────────────────────────────

interface RoundStats {
  round: number
  cacheTokens: number
  promptTokens: number
  generatedTokens: number
  contextSlides: number
  nPastBeforeTools: number
  tokensPerSecond: number
  timeToFirstToken: number
}

interface AgenticResult {
  answer: string
  toolCalls: ParsedToolCall[]
  rounds: number
  roundStats: RoundStats[]
}

async function agenticTurn(
  modelId: string,
  history: Array<{ role: string; content: string }>,
  tools: ToolInput[],
  kvCache: string,
  maxRounds = 5,
  verbose = false,
): Promise<AgenticResult> {
  const chainStartIdx = history.length
  const allToolCalls: ParsedToolCall[] = []
  const roundStats: RoundStats[] = []
  let rounds = 0
  let fullText = ""

  for (let round = 0; round < maxRounds; round++) {
    rounds++

    if (verbose) console.log(`\n  [Round ${round + 1}]`)

    const result = completion({
      modelId,
      history,
      tools,
      kvCache,
      stream: true,
    })

    // Collect full response
    fullText = ""
    for await (const token of result.tokenStream) {
      fullText += token
      if (verbose) process.stdout.write(token)
    }
    if (verbose) console.log()

    // Collect stats
    const stats = await result.stats
    if (stats) {
      const rs: RoundStats = {
        round: rounds,
        cacheTokens: stats.cacheTokens ?? 0,
        promptTokens: stats.promptTokens ?? 0,
        generatedTokens: stats.generatedTokens ?? 0,
        contextSlides: stats.contextSlides ?? 0,
        nPastBeforeTools: stats.nPastBeforeTools ?? 0,
        tokensPerSecond: stats.tokensPerSecond ?? 0,
        timeToFirstToken: stats.timeToFirstToken ?? 0,
      }
      roundStats.push(rs)
      const trimmed = stats.toolsTrimmed ? " toolsTrimmed=YES" : ""
      console.log(`  Stats: prompt=${rs.promptTokens} cache=${rs.cacheTokens} gen=${rs.generatedTokens} nPastBeforeTools=${rs.nPastBeforeTools} slides=${rs.contextSlides} tps=${rs.tokensPerSecond.toFixed(1)}${trimmed}`)
    }

    // Parse tool calls
    const toolCalls = parseToolCalls(fullText)

    if (toolCalls.length === 0) {
      // Final answer — strip thinking, cleanup history
      const cleanAnswer = stripThinking(fullText)

      if (allToolCalls.length > 0) {
        // Remove all tool exchange messages, keep only clean answer
        history.splice(chainStartIdx)
        if (verbose) console.log(`  [Cleanup: removed ${rounds - 1} tool exchange(s)]`)
      }

      history.push({ role: "assistant", content: cleanAnswer })
      return { answer: cleanAnswer, toolCalls: allToolCalls, rounds, roundStats }
    }

    // Tool round — keep full raw output (thinking + tool_call XML) in content.
    // The SDK only passes role+content to the addon (not tool_calls field),
    // so <tool_call> XML must stay in content for the template to render it.
    history.push({
      role: "assistant",
      content: fullText,
    })

    // Execute tools and add responses
    for (const tc of toolCalls) {
      const toolResult = executeToolCall(tc.name, tc.arguments)
      history.push({ role: "tool", content: toolResult })
      allToolCalls.push(tc)
      if (verbose) console.log(`  Tool: ${tc.name}(${JSON.stringify(tc.arguments)}) -> ${toolResult.slice(0, 100)}...`)
    }
  }

  return { answer: fullText, toolCalls: allToolCalls, rounds, roundStats }
}

// ─── Test Scenarios ──────────────────────────────────────────────────────────

type Scenario = {
  name: string
  description: string
  run: (modelId: string, kvCache: string, verbose: boolean) => Promise<{ passed: boolean; detail: string }>
}

const scenarios: Scenario[] = [
  {
    name: "Simple tool call",
    description: "Weather in Tokyo → should call get_weather",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What's the weather like in Tokyo right now?" },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool], kvCache + "-s1", 1, verbose)
      const hasWeather = result.toolCalls.some((tc) => tc.name === "get_weather")
      return { passed: hasWeather, detail: `tool_calls=${result.toolCalls.map((t) => t.name).join(",")}` }
    },
  },
  {
    name: "No tool needed",
    description: "Capital of France → should answer directly",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What is the capital of France?" },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool, searchTool], kvCache + "-s2", 1, verbose)
      const noTools = result.toolCalls.length === 0
      const mentionsParis = result.answer.toLowerCase().includes("paris")
      return { passed: noTools && mentionsParis, detail: `tools=${result.toolCalls.length}, paris=${mentionsParis}` }
    },
  },
  {
    name: "2-step chain",
    description: "Weather in Nexora HQ → search then get_weather",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful assistant. You must use the search tool to look up information you don't know. Do not guess. Use tools step by step." },
        { role: "user", content: "What's the current weather in the city where Nexora Technologies has its headquarters? I don't know which city that is, so you'll need to search for it first." },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool, searchTool], kvCache + "-s3", 5, verbose)
      const names = result.toolCalls.map((tc) => tc.name)
      const hasSearch = names.includes("search_web")
      const hasWeather = names.includes("get_weather")
      const correctOrder = hasSearch && hasWeather && names.indexOf("search_web") < names.indexOf("get_weather")
      return {
        passed: correctOrder,
        detail: `chain=${names.join(" → ")}, order=${correctOrder ? "correct" : "wrong"}`,
      }
    },
  },
  {
    name: "Multi-tool single turn",
    description: "Weather AND stock price → both tools in one response",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful assistant. When asked for multiple pieces of information, call all relevant tools." },
        { role: "user", content: "I need two things: the weather in Paris and the stock price of AAPL. Please get both." },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool, stockTool], kvCache + "-s4", 1, verbose)
      const names = new Set(result.toolCalls.map((tc) => tc.name))
      return { passed: names.size >= 2, detail: `tools=${[...names].join(",")}` }
    },
  },
  {
    name: "Multi-tool chain",
    description: "3 tools called at once → 3 responses → model summarizes all",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful assistant. When asked for multiple pieces of information, call all relevant tools at once." },
        { role: "user", content: "I need three things at once: the weather in Tokyo, the weather in London, and the stock price of AAPL. Get all three." },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool, stockTool], kvCache + "-s5b", 3, verbose)
      const names = result.toolCalls.map((tc) => tc.name)
      const weatherCount = names.filter((n) => n === "get_weather").length
      const hasStock = names.includes("get_stock_price")
      // Pass if model called at least 2 weather + 1 stock, AND produced a final answer
      const passed = weatherCount >= 2 && hasStock && result.answer.length > 10
      return {
        passed,
        detail: `tools=${names.join(",")}, weather=${weatherCount}, stock=${hasStock ? "yes" : "no"}, answer_len=${result.answer.length}`,
      }
    },
  },
  {
    name: "Long chain (4-step)",
    description: "Weather in CEO's hometown → search CEO → search hometown → get_weather",
    async run(modelId, kvCache, verbose) {
      const history = [
        { role: "system", content: "You are a helpful research assistant. You MUST use the get_weather tool to check weather — never guess weather conditions. Use search_web to find any information you don't know. Do not skip steps." },
        { role: "user", content: "I want to know the current weather in the hometown of the CEO of Nexora Technologies. I don't know who the CEO is or where they're from. Search for the CEO first, then search for their hometown, then use the weather tool to check the weather there." },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool, searchTool], kvCache + "-s5", 8, verbose)
      const names = result.toolCalls.map((tc) => tc.name)
      const searchCount = names.filter((n) => n === "search_web").length
      const hasWeather = names.includes("get_weather")
      const weatherLast = names.length > 0 && names[names.length - 1] === "get_weather"
      return {
        passed: searchCount >= 2 && hasWeather,
        detail: `chain=${names.join(" → ")}, searches=${searchCount}`,
      }
    },
  },
  {
    name: "Follow-up same tool",
    description: "Weather Paris (cleaned) → 'And London?' → should call tool again",
    async run(modelId, kvCache, verbose) {
      const history: Array<{ role: string; content: string }> = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What's the weather in Paris?" },
        { role: "assistant", content: "The weather in Paris is 18°C, partly cloudy with 65% humidity." },
        { role: "user", content: "And in London?" },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool], kvCache + "-s6", 2, verbose)
      const hasWeather = result.toolCalls.some((tc) => tc.name === "get_weather")
      const hasLondon = result.toolCalls.some((tc) =>
        JSON.stringify(tc.arguments).toLowerCase().includes("london"),
      )
      return { passed: hasWeather && hasLondon, detail: `weather=${hasWeather}, london=${hasLondon}` }
    },
  },
  {
    name: "Follow-up coreference",
    description: "'About Nexora' (cleaned) → 'Who is their CEO?' → should search",
    async run(modelId, kvCache, verbose) {
      const history: Array<{ role: string; content: string }> = [
        { role: "system", content: "You are a helpful assistant. Use tools to look up information you don't know." },
        { role: "user", content: "Tell me about Nexora Technologies." },
        { role: "assistant", content: "Nexora Technologies is a Swiss AI company headquartered in Zurich, Switzerland. Founded in 2019, they specialize in edge computing solutions." },
        { role: "user", content: "Who is their CEO?" },
      ]
      const result = await agenticTurn(modelId, history, [searchTool], kvCache + "-s7", 3, verbose)
      const searchedNexora = result.toolCalls.some((tc) =>
        JSON.stringify(tc.arguments).toLowerCase().includes("nexora"),
      )
      const mentionsCeo = result.answer.toLowerCase().includes("elena") || result.answer.toLowerCase().includes("voss")
      return { passed: searchedNexora && mentionsCeo, detail: `searched=${searchedNexora}, found_ceo=${mentionsCeo}` }
    },
  },
  {
    name: "User correction",
    description: "Weather Paris (cleaned) → 'I meant Paris Texas' → should re-call",
    async run(modelId, kvCache, verbose) {
      const history: Array<{ role: string; content: string }> = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "What's the weather in Paris?" },
        { role: "assistant", content: "The weather in Paris is 18°C, partly cloudy with 65% humidity." },
        { role: "user", content: "No, I meant Paris, Texas, not France. Can you check again?" },
      ]
      const result = await agenticTurn(modelId, history, [weatherTool], kvCache + "-s8", 2, verbose)
      const hasWeather = result.toolCalls.some((tc) => tc.name === "get_weather")
      const hasTexas = result.toolCalls.some((tc) =>
        JSON.stringify(tc.arguments).toLowerCase().includes("texas"),
      )
      return { passed: hasWeather && hasTexas, detail: `weather=${hasWeather}, texas=${hasTexas}` }
    },
  },
]

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const verbose = process.argv.includes("--verbose")
  const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="))
  const scenarioFilter = scenarioArg ? scenarioArg.split("=")[1] : "all"

  console.log("Loading model...")
  const modelId = await loadModel({
    modelSrc: QWEN3_1_7B_INST_Q4,
    modelType: "llm",
    modelConfig: {
      ctx_size: 4096,
      tools: true,
      toolsMode: "dynamic",
    },
    onProgress: (p) => process.stdout.write(`\r  ${p.percentage.toFixed(0)}%`),
  })
  console.log(`\nModel loaded: ${modelId}`)

  const kvCache = `agentic-${Date.now()}`
  const toRun = scenarioFilter === "all"
    ? scenarios
    : scenarios.filter((_, i) => String(i + 1) === scenarioFilter)

  const results: Array<{ name: string; passed: boolean; detail: string }> = []

  for (const [i, s] of toRun.entries()) {
    console.log(`\n${"=".repeat(60)}`)
    console.log(`SCENARIO ${i + 1}: ${s.name}`)
    console.log(`  ${s.description}`)
    console.log("=".repeat(60))

    try {
      const { passed, detail } = await s.run(modelId, kvCache, verbose)
      const status = passed ? "PASS" : "FAIL"
      console.log(`\n  >>> ${status}: ${detail}`)
      results.push({ name: s.name, passed, detail })
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      console.error(`\n  >>> ERROR: ${errMsg}`)
      results.push({ name: s.name, passed: false, detail: `ERROR: ${errMsg}` })
    }
  }

  // Summary
  console.log(`\n${"=".repeat(60)}`)
  console.log("SUMMARY")
  console.log("=".repeat(60))
  const total = results.length
  const passed = results.filter((r) => r.passed).length
  for (const r of results) {
    const status = r.passed ? "PASS" : "FAIL"
    console.log(`  ${r.name.padEnd(30)} ${status}  ${r.detail}`)
  }
  console.log(`\n  ${passed}/${total} scenarios passed`)

  await unloadModel({ modelId, clearStorage: false })
}

main().catch(console.error)
