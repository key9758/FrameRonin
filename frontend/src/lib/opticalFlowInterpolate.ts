/**
 * OpenCV.js：相邻帧之间插入时间插值帧。
 * - 默认「双向」Farneback：分别计算 I0→I1 与 I1→I0，对两帧做反向 remap 再融合，减轻单方向拖影与空洞。
 * - 可选对光流高斯平滑、位移限幅，抑制异常向量。
 */
import { loadOpenCv } from './pixellise/opencv'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cv = any

export type OpticalFlowQuality = 'fast' | 'balanced' | 'high'

export interface OpticalFlowInterpolateOptions {
  /** 0 = 前一帧，0.5 = 中点，1 ≈ 后一帧 */
  alpha: number
  nearestNeighbor: boolean
  /** 双向光流 + 加权融合（推荐） */
  bidirectional: boolean
  /** 金字塔与窗口：high 更稳但更慢 */
  quality: OpticalFlowQuality
  /** 对光流场做轻微高斯平滑，抑制椒盐噪声 */
  smoothFlow: boolean
  /** 单像素位移上限 = min(w,h) × 该值，避免异常跳跃 */
  maxMotionRelative: number
}

const DEFAULT_OPTIONS: OpticalFlowInterpolateOptions = {
  alpha: 0.5,
  nearestNeighbor: false,
  bidirectional: true,
  quality: 'balanced',
  smoothFlow: true,
  maxMotionRelative: 0.35,
}

/** Farneback: pyr_scale, levels, winsize, iterations, poly_n, poly_sigma, flags */
function farnebackArgs(q: OpticalFlowQuality): [number, number, number, number, number, number, number] {
  switch (q) {
    case 'fast':
      return [0.5, 3, 15, 3, 5, 1.1, 0]
    case 'balanced':
      return [0.5, 4, 21, 5, 7, 1.5, 0]
    case 'high':
      return [0.5, 5, 31, 7, 7, 1.5, 0]
    default:
      return [0.5, 4, 21, 5, 7, 1.5, 0]
  }
}

function sizeOf(
  src: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
): { w: number; h: number } {
  if (src instanceof HTMLCanvasElement || src instanceof ImageBitmap) {
    return { w: src.width, h: src.height }
  }
  return { w: src.naturalWidth, h: src.naturalHeight }
}

function drawToCanvas(
  source: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  w: number,
  h: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(source, 0, 0, w, h)
  return canvas
}

function assertSameSize(
  frames: (HTMLImageElement | HTMLCanvasElement | ImageBitmap)[],
): { w: number; h: number } {
  if (frames.length === 0) throw new Error('no frames')
  const { w, h } = sizeOf(frames[0]!)
  for (let i = 1; i < frames.length; i++) {
    const s = sizeOf(frames[i]!)
    if (s.w !== w || s.h !== h) {
      throw new Error(`Frame size mismatch: frame 1 is ${w}×${h}, frame ${i + 1} is ${s.w}×${s.h}`)
    }
  }
  return { w, h }
}

function clampFlowMagnitude(flow: { data32F: Float32Array; rows: number; cols: number }, maxMag: number) {
  const d = flow.data32F
  const len = flow.rows * flow.cols
  for (let idx = 0; idx < len; idx++) {
    const o = idx * 2
    const fx = d[o]!
    const fy = d[o + 1]!
    const m = Math.hypot(fx, fy)
    if (m > maxMag && m > 1e-6) {
      const s = maxMag / m
      d[o] = fx * s
      d[o + 1] = fy * s
    }
  }
}

function fillRemapMaps(
  flow: { data32F: Float32Array; rows: number; cols: number },
  alpha: number,
  mapX: { data32F: Float32Array },
  mapY: { data32F: Float32Array },
) {
  const fData = flow.data32F
  const mx = mapX.data32F
  const my = mapY.data32F
  const cols = flow.cols
  const rows = flow.rows
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const idx = i * cols + j
      const fx = fData[idx * 2]!
      const fy = fData[idx * 2 + 1]!
      mx[idx] = j - alpha * fx
      my[idx] = i - alpha * fy
    }
  }
}

/**
 * 由相邻两帧生成插值帧（双向 Farneback + 融合）。
 */
export async function interpolateMidFrameOpticalFlow(
  prev: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  next: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
  options: Partial<OpticalFlowInterpolateOptions> = {},
): Promise<HTMLCanvasElement> {
  const opt: OpticalFlowInterpolateOptions = { ...DEFAULT_OPTIONS, ...options }
  const { w, h } = assertSameSize([prev, next])
  const cv = await loadOpenCv()

  const c0 = drawToCanvas(prev, w, h)
  const c1 = drawToCanvas(next, w, h)
  const ctx0 = c0.getContext('2d')!
  const ctx1 = c1.getContext('2d')!
  const id0 = ctx0.getImageData(0, 0, w, h)
  const id1 = ctx1.getImageData(0, 0, w, h)

  const rgba0 = cv.matFromImageData(id0)
  const rgba1 = cv.matFromImageData(id1)
  const gray0 = new cv.Mat()
  const gray1 = new cv.Mat()
  const flow01 = new cv.Mat(h, w, cv.CV_32FC2)
  const flow10 = new cv.Mat(h, w, cv.CV_32FC2)
  const mapX = new cv.Mat(h, w, cv.CV_32FC1)
  const mapY = new cv.Mat(h, w, cv.CV_32FC1)
  const dst = new cv.Mat()

  const fb = farnebackArgs(opt.quality)
  const alpha = Math.max(0, Math.min(1, opt.alpha))
  const maxMag = Math.min(w, h) * Math.max(0.05, Math.min(0.95, opt.maxMotionRelative))
  const interpFlag = opt.nearestNeighbor ? cv.INTER_NEAREST : cv.INTER_LINEAR
  const border = new cv.Scalar(0, 0, 0, 0)

  try {
    cv.cvtColor(rgba0, gray0, cv.COLOR_RGBA2GRAY)
    cv.cvtColor(rgba1, gray1, cv.COLOR_RGBA2GRAY)

    cv.calcOpticalFlowFarneback(gray0, gray1, flow01, fb[0]!, fb[1]!, fb[2]!, fb[3]!, fb[4]!, fb[5]!, fb[6]!)
    if (opt.smoothFlow) {
      cv.GaussianBlur(flow01, flow01, new cv.Size(5, 5), 0)
    }
    clampFlowMagnitude(flow01, maxMag)

    if (opt.bidirectional) {
      cv.calcOpticalFlowFarneback(gray1, gray0, flow10, fb[0]!, fb[1]!, fb[2]!, fb[3]!, fb[4]!, fb[5]!, fb[6]!)
      if (opt.smoothFlow) {
        cv.GaussianBlur(flow10, flow10, new cv.Size(5, 5), 0)
      }
      clampFlowMagnitude(flow10, maxMag)

      const warp0 = new cv.Mat()
      const warp1 = new cv.Mat()
      try {
        fillRemapMaps(flow01, alpha, mapX, mapY)
        cv.remap(rgba0, warp0, mapX, mapY, interpFlag, cv.BORDER_CONSTANT, border)

        fillRemapMaps(flow10, alpha, mapX, mapY)
        cv.remap(rgba1, warp1, mapX, mapY, interpFlag, cv.BORDER_CONSTANT, border)

        cv.addWeighted(warp0, 0.5, warp1, 0.5, 0, dst)
      } finally {
        warp0.delete()
        warp1.delete()
      }
    } else {
      fillRemapMaps(flow01, alpha, mapX, mapY)
      cv.remap(rgba0, dst, mapX, mapY, interpFlag, cv.BORDER_CONSTANT, border)
    }

    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    cv.imshow(out, dst)
    return out
  } finally {
    rgba0.delete()
    rgba1.delete()
    gray0.delete()
    gray1.delete()
    flow01.delete()
    flow10.delete()
    mapX.delete()
    mapY.delete()
    dst.delete()
  }
}

/**
 * 在每一对相邻原帧之间插入一帧。N 张原图 → 2N−1 张（含原帧顺序）。
 */
export async function expandFramesWithOpticalMidpoints(
  frames: (HTMLImageElement | HTMLCanvasElement | ImageBitmap)[],
  options: Partial<OpticalFlowInterpolateOptions> = {},
  onProgress?: (done: number, total: number) => void,
): Promise<HTMLCanvasElement[]> {
  if (frames.length < 2) {
    throw new Error('At least 2 frames are required')
  }
  const { w, h } = assertSameSize(frames)
  const opt: OpticalFlowInterpolateOptions = { ...DEFAULT_OPTIONS, ...options }
  const out: HTMLCanvasElement[] = []
  const pairs = frames.length - 1
  for (let i = 0; i < frames.length; i++) {
    out.push(drawToCanvas(frames[i]!, w, h))
    if (i < frames.length - 1) {
      const mid = await interpolateMidFrameOpticalFlow(frames[i]!, frames[i + 1]!, opt)
      out.push(mid)
      onProgress?.(i + 1, pairs)
    }
  }
  return out
}
