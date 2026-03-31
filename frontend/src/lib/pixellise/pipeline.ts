import type { AdvancedPixelateOptions } from './types'
import { fileToImageData, imageDataToPngBlob } from './imageDataOps'
import { loadOpenCv } from './opencv'
import { computeMeshWithScaling } from './mesh'
import { runWorkerProcessing } from './workerBridge'
import { maxSafeUpscaleForImage } from './safeUpscale'

export { maxSafeUpscaleForImage, PIXELLISE_MAX_SCALED_PIXELS } from './safeUpscale'

function yieldToBrowser(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}

export interface PixelliseRestoreResult {
  blob: Blob
  /** 实际用于网格检测的放大倍数（可能因图片尺寸被自动下调） */
  upscaleUsed: number
  upscaleCapped: boolean
  upscaleRequested: number
}

export async function runPixelliseRestore(
  file: File,
  options: AdvancedPixelateOptions,
  onStatus: (messageKey: string) => void,
): Promise<PixelliseRestoreResult> {
  onStatus('pixelateAdvancedProgressLoadImage')
  await yieldToBrowser()
  const input = await fileToImageData(file)

  onStatus('pixelateAdvancedProgressOpenCv')
  await yieldToBrowser()
  const cv = await loadOpenCv()

  onStatus('pixelateAdvancedProgressMesh')
  await yieldToBrowser()
  const requested = Math.max(1, Math.min(7, Math.floor(options.upscale)))
  const maxU = maxSafeUpscaleForImage(input.width, input.height)
  const u = Math.min(requested, maxU)
  const upscaleCapped = u < requested
  const { mesh, scaledWidth, scaledHeight } = computeMeshWithScaling(cv, input, u)

  onStatus('pixelateAdvancedProgressWorker')
  await yieldToBrowser()
  const resultImage = await runWorkerProcessing(input, mesh, {
    scaledWidth,
    scaledHeight,
    numColors: options.numColors,
    scaleResult: Math.max(1, Math.min(5, Math.floor(options.scaleResult))),
    transparentBackground: options.transparentBackground,
  })

  onStatus('pixelateAdvancedProgressEncode')
  await yieldToBrowser()
  const blob = await imageDataToPngBlob(resultImage)
  return { blob, upscaleUsed: u, upscaleCapped, upscaleRequested: requested }
}
