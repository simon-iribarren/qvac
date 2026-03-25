'use strict'

const fs = require('bare-fs')
const path = require('bare-path')
const FilesystemDL = require('@qvac/dl-filesystem')
const ImgStableDiffusion = require('../index')

/**
 * Stable Diffusion XL img2img example
 * 
 * Transforms an input image using a text prompt.
 * This example uses SDXL with standard configuration.
 */

async function main () {
  const modelDir = path.join(__dirname, '../models')
//   const inputImagePath = path.join(__dirname, '../temp/nik_headshot_832.jpeg')
  const inputImagePath = path.join(__dirname, '../temp/benjaminrutz.jpeg')
  const outputImagePath = path.join(__dirname, '../temp/benjaminrutz_transformed_sdxl.png')

  console.log('Loading Stable Diffusion XL model...')

  const loader = new FilesystemDL({ dirPath: modelDir })

  const model = new ImgStableDiffusion(
    {
      loader,
      logger: console,
      diskPath: modelDir,
      modelName: 'stable-diffusion-xl-base-1.0-Q8_0.gguf'
    },
    {
      threads: 4,
      device: 'gpu'
    }
  )

  try {
    // Load model weights
    await model.load()
    console.log('Model loaded!')

    // Read input image
    const initImage = fs.readFileSync(inputImagePath)
    console.log(`Input image: ${initImage.length} bytes`)

    const STEPS = 40        // effective denoising steps = floor(STEPS * STRENGTH)
    const STRENGTH = 0.7   // effective denoising steps = floor(STEPS * STRENGTH)

    console.log(`\nGenerating transformed image...`)
    console.log(`  Steps    : ${STEPS}  (effective denoising steps: ${Math.floor(STEPS * STRENGTH)})`)
    console.log(`  Strength : ${STRENGTH}`)
    console.log(`  Note     : VAE encode runs first (no progress tick) — please wait...\n`)

    const tGenStart = Date.now()
    let lastStepTime = tGenStart

    const response = await model.run({
      prompt: 'a female version of this photo, professional headshot.',
      negative_prompt: 'blurry, low quality, distorted',
      init_image: initImage,
      width: 1024,
      height: 1024,
      strength: STRENGTH,
      steps: STEPS,
      cfg_scale: 9.0,
      seed: 42
    })

    await response
      .onUpdate((data) => {
        if (data instanceof Uint8Array) {
          const totalMs = Date.now() - tGenStart
          console.log(`\n✓ Image generated in ${(totalMs / 1000).toFixed(1)}s`)
          fs.writeFileSync(outputImagePath, data)
          console.log(`✓ Saved to: ${outputImagePath}`)
        } else if (typeof data === 'string') {
          try {
            const tick = JSON.parse(data)
            if ('step' in tick && 'total' in tick) {
              const now = Date.now()
              const stepMs = now - lastStepTime
              lastStepTime = now
              const wallMs = now - tGenStart
              process.stdout.write(
                `\r  step ${tick.step}/${tick.total} | step took ${(stepMs / 1000).toFixed(1)}s | wall ${(wallMs / 1000).toFixed(1)}s elapsed  `
              )
            }
          } catch (_) {}
        }
      })
      .await()

    console.log('\nDone!')
  } catch (error) {
    console.error('Error:', error)
  } finally {
    await model.unload()
    await loader.close()
  }
}

main()
