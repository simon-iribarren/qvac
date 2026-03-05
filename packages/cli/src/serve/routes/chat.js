import { readBody, sendJson, sendError, initSSE, sendSSE, endSSE } from '../http.js'
import { resolveModelAlias } from '../config.js'
import { sdkCompletion } from '../sdk.js'
import {
  openaiMessagesToHistory,
  openaiToolsToSdk,
  sdkToolCallsToOpenai,
  logUnsupportedParams
} from '../translate.js'

export async function handleChatCompletions (req, res, ctx) {
  const body = await readBody(req)

  if (!body.model) {
    return sendError(res, 400, 'missing_model', '"model" is required.')
  }

  if (!body.messages || !Array.isArray(body.messages)) {
    return sendError(res, 400, 'missing_messages', '"messages" must be an array.')
  }

  const modelEntry = resolveModelAlias(ctx.serveConfig, body.model) ?? ctx.registry.getEntry(body.model)

  if (!modelEntry) {
    return sendError(res, 404, 'model_not_found', `Model "${body.model}" is not available. Check serve.models config.`)
  }

  if (modelEntry.endpointCategory !== 'chat') {
    return sendError(res, 400, 'invalid_model_type', `Model "${body.model}" does not support chat completions.`)
  }

  const registryEntry = ctx.registry.getEntry(modelEntry.alias ?? modelEntry.id)
  if (!registryEntry || registryEntry.state !== ctx.registry.STATES.READY) {
    return sendError(res, 503, 'model_not_ready', `Model "${body.model}" is not loaded yet.`)
  }

  logUnsupportedParams(body, ctx.logger)

  const sdkModelId = registryEntry.sdkModelId ?? registryEntry.id
  const history = openaiMessagesToHistory(body.messages)
  const tools = openaiToolsToSdk(body.tools)
  const modelAlias = modelEntry.alias ?? modelEntry.id

  try {
    if (body.stream) {
      return await handleStreamingCompletion(res, { sdkModelId, history, tools, modelAlias })
    }
    return await handleBlockingCompletion(res, { sdkModelId, history, tools, modelAlias })
  } catch (err) {
    ctx.logger.error(`Completion error for "${modelAlias}": ${err.message}`)
    sendError(res, 500, 'completion_error', err.message)
  }
}

async function handleBlockingCompletion (res, { sdkModelId, history, tools, modelAlias }) {
  const result = await sdkCompletion({
    modelId: sdkModelId,
    history,
    stream: false,
    tools
  })

  const text = await result.text
  const stats = await result.stats
  const toolCalls = await result.toolCalls

  const hasToolCalls = toolCalls && toolCalls.length > 0
  const finishReason = hasToolCalls ? 'tool_calls' : 'stop'

  const message = { role: 'assistant', content: text || null }
  if (hasToolCalls) {
    message.tool_calls = sdkToolCallsToOpenai(toolCalls)
  }

  const completionTokens = text ? text.split(/\s+/).length : 0

  sendJson(res, 200, {
    id: `chatcmpl-${randomId()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelAlias,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: {
      prompt_tokens: 0,
      completion_tokens: completionTokens,
      total_tokens: completionTokens
    }
  })
}

async function handleStreamingCompletion (res, { sdkModelId, history, tools, modelAlias }) {
  const result = await sdkCompletion({
    modelId: sdkModelId,
    history,
    stream: true,
    tools
  })

  initSSE(res)

  const id = `chatcmpl-${randomId()}`
  const created = Math.floor(Date.now() / 1000)

  sendSSE(res, {
    id,
    object: 'chat.completion.chunk',
    created,
    model: modelAlias,
    choices: [{
      index: 0,
      delta: { role: 'assistant', content: '' },
      finish_reason: null
    }]
  })

  let tokenCount = 0

  for await (const token of result.tokenStream) {
    tokenCount++
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelAlias,
      choices: [{
        index: 0,
        delta: { content: token },
        finish_reason: null
      }]
    })
  }

  const toolCalls = await result.toolCalls
  if (toolCalls && toolCalls.length > 0) {
    const openaiToolCalls = sdkToolCallsToOpenai(toolCalls)
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelAlias,
      choices: [{
        index: 0,
        delta: { tool_calls: openaiToolCalls },
        finish_reason: 'tool_calls'
      }]
    })
  } else {
    sendSSE(res, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: modelAlias,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop'
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: tokenCount,
        total_tokens: tokenCount
      }
    })
  }

  endSSE(res)
}

function randomId () {
  return Math.random().toString(36).slice(2, 12)
}
