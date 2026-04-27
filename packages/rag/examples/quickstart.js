'use strict'

const path = require('bare-path')
const Corestore = require('corestore')
const EmbedderPlugin = require('@qvac/embed-llamacpp')
const LlmPlugin = require('@qvac/llm-llamacpp')
const QvacLogger = require('@qvac/logging')

const { RAG, HyperDBAdapter, QvacLlmAdapter } = require('../index')
const knowledgeBase = require('./knowledge-base.json')
const { downloadModel } = require('./utils')

const EMBED_MODEL_URL = 'https://huggingface.co/ChristianAzinn/gte-large-gguf/resolve/main/gte-large_fp16.gguf'
const LLM_MODEL_URL = 'https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_0.gguf'

const store = new Corestore('./store')
const query = 'Who won the individual title in LIV Golf UK by JCB in 2025?'

async function main () {
  // 1. Download embedder + LLM model files
  const [embedFile, embedDir] = await downloadModel(EMBED_MODEL_URL, 'gte-large_fp16.gguf')
  const [llmFile, llmDir] = await downloadModel(LLM_MODEL_URL, 'Llama-3.2-1B-Instruct-Q4_0.gguf')

  // 2. Construct embedder with the new files-based addon shape
  const embedder = new EmbedderPlugin({
    files: { model: [path.join(embedDir, embedFile)] },
    config: { device: 'gpu', gpu_layers: '99' },
    logger: console,
    opts: { stats: true }
  })
  await embedder.load()

  const embeddingFunction = async (text) => {
    const response = await embedder.run(text)
    const embeddings = await response.await()

    if (Array.isArray(text)) {
      return embeddings[0].map(embedding => Array.from(embedding))
    } else {
      return Array.from(embeddings[0][0])
    }
  }

  // 3. Construct LLM with the new files-based addon shape
  const llm = new LlmPlugin({
    files: { model: [path.join(llmDir, llmFile)] },
    config: { device: 'gpu', gpu_layers: '99', ctx_size: '1024' },
    logger: console,
    opts: { stats: true }
  })
  await llm.load()
  const llmAdapter = new QvacLlmAdapter(llm)

  const dbAdapter = new HyperDBAdapter({ store })
  const logger = new QvacLogger(console)

  const rag = new RAG({ embeddingFunction, dbAdapter, llm: llmAdapter, logger })
  await rag.ready()

  const knowledgeBaseMapped = knowledgeBase.map(kb => kb.text)

  const docs = await rag.ingest(knowledgeBaseMapped, embedFile)

  const response = await rag.infer(query)

  let fullResponse = ''
  await response
    .onUpdate(update => {
      fullResponse += update
    })
    .await()

  console.log(fullResponse)

  await rag.deleteEmbeddings(docs.processed.map(doc => doc.id))

  await rag.close()
  await llm.unload()
  await embedder.unload()
  await store.close()
}

main().catch(console.error)
