let sdk = null

export async function getSDK () {
  if (sdk) return sdk

  try {
    sdk = await import('@qvac/sdk')
  } catch {
    throw new Error(
      '@qvac/sdk is required for "qvac serve". Install it: npm install @qvac/sdk'
    )
  }

  return sdk
}

export async function sdkLoadModel ({ src, type, config }) {
  const { loadModel } = await getSDK()
  const modelId = await loadModel({
    modelSrc: src,
    modelType: type,
    modelConfig: config
  })
  return modelId
}

export async function sdkUnloadModel (modelId) {
  const { unloadModel } = await getSDK()
  await unloadModel({ modelId })
}

export async function sdkCompletion ({ modelId, history, stream, tools }) {
  const { completion } = await getSDK()
  return completion({
    modelId,
    history,
    stream: stream ?? false,
    tools
  })
}

export async function sdkEmbed ({ modelId, text }) {
  const { embed } = await getSDK()
  return embed({ modelId, text })
}

export async function sdkClose () {
  const { close } = await getSDK()
  await close()
}
