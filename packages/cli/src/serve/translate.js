export function openaiMessagesToHistory (messages) {
  return messages.map((msg) => ({
    role: msg.role,
    content: typeof msg.content === 'string'
      ? msg.content
      : (msg.content ?? '').toString()
  }))
}

export function openaiToolsToSdk (tools) {
  if (!tools || tools.length === 0) return undefined

  return tools.map((t) => {
    if (t.type !== 'function' || !t.function) return null
    const fn = t.function
    return {
      type: 'function',
      name: fn.name,
      description: fn.description ?? '',
      parameters: fn.parameters ?? { type: 'object', properties: {} }
    }
  }).filter(Boolean)
}

export function sdkToolCallsToOpenai (toolCalls) {
  if (!toolCalls || toolCalls.length === 0) return undefined

  return toolCalls.map((tc) => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments)
    }
  }))
}

export function logUnsupportedParams (body, logger) {
  const ignored = ['temperature', 'max_tokens', 'top_p', 'n', 'logprobs',
    'response_format', 'seed', 'frequency_penalty', 'presence_penalty',
    'stop', 'max_completion_tokens']

  for (const param of ignored) {
    if (body[param] !== undefined) {
      logger.warn(`Ignoring unsupported OpenAI param: ${param}=${JSON.stringify(body[param])}`)
    }
  }
}
