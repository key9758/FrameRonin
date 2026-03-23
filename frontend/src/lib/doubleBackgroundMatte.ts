/**
 * 双背景抠图：黑底图与白底图差分提取 Alpha（与 ImageMatte 中算法一致）
 */

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('ERR_LOAD_IMAGE'))
    }
    img.src = url
  })
}

/** 黑底 + 白底 → 带透明通道结果 Canvas */
export function processDoubleBackground(
  blackImg: HTMLImageElement,
  whiteImg: HTMLImageElement,
  tolerance: number = 50,
  edgeContrast: number = 50
): HTMLCanvasElement {
  const width = blackImg.naturalWidth
  const height = blackImg.naturalHeight
  if (whiteImg.naturalWidth !== width || whiteImg.naturalHeight !== height) {
    throw new Error('dimension mismatch')
  }
  const tolScale = 0.5 + tolerance / 100
  const gamma = 0.5 + edgeContrast / 100
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(blackImg, 0, 0)
  const blackData = ctx.getImageData(0, 0, width, height).data
  ctx.drawImage(whiteImg, 0, 0)
  const whiteData = ctx.getImageData(0, 0, width, height).data
  const result = ctx.createImageData(width, height)
  const resData = result.data
  for (let i = 0; i < blackData.length; i += 4) {
    const rb = blackData[i]!
    const gb = blackData[i + 1]!
    const bb = blackData[i + 2]!
    const rw = whiteData[i]!
    const gw = whiteData[i + 1]!
    const bw = whiteData[i + 2]!
    const diff = ((rw - rb) + (gw - gb) + (bw - bb)) / 3
    let alpha = Math.max(0, Math.min(255, 255 - diff * tolScale))
    alpha = Math.round(255 * Math.pow(alpha / 255, gamma))
    resData[i] = alpha > 0 ? Math.round((rb * 255) / alpha) : 0
    resData[i + 1] = alpha > 0 ? Math.round((gb * 255) / alpha) : 0
    resData[i + 2] = alpha > 0 ? Math.round((bb * 255) / alpha) : 0
    resData[i + 3] = alpha
  }
  ctx.putImageData(result, 0, 0)
  return canvas
}

const NEIGH8: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
]

/** 十字 4 邻域偏移 */
const ERODE4: readonly [number, number][] = [
  [0, -1],
  [-1, 0],
  [1, 0],
  [0, 1],
]

/**
 * 邻域 Alpha ≤ 此值视为「背景」，用于判定「贴边」像素（避免对整条半透明带做 min 一次塌一片）。
 */
const FRONTIER_BG_ALPHA = 10

/**
 * 每一遍：只对**当前最外一层**（贴背景或贴图缘）的像素硬减 Alpha，RGB 按透明度同比缩放（仍硬、不模糊）。
 * 多遍后轮廓往里慢慢收，单遍变化远小于形态学 min。
 */
const FRONTIER_SHAVE = 22

function erodeAlphaFrontierLayers(d: Uint8ClampedArray, w: number, h: number, passes: number): void {
  if (passes <= 0) return
  const border = new Uint8Array(w * h)

  for (let pass = 0; pass < passes; pass++) {
    border.fill(0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const a = d[i + 3]!
        if (a <= FRONTIER_BG_ALPHA) continue
        let isFront = false
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1) {
          isFront = true
        } else {
          for (const [dx, dy] of ERODE4) {
            const na = d[((y + dy) * w + (x + dx)) * 4 + 3]!
            if (na <= FRONTIER_BG_ALPHA) {
              isFront = true
              break
            }
          }
        }
        if (isFront) border[y * w + x] = 1
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!border[y * w + x]!) continue
        const i = (y * w + x) * 4
        const a = d[i + 3]!
        if (a <= 0) continue
        const na = Math.max(0, a - FRONTIER_SHAVE)
        if (na <= 0) {
          d[i] = 0
          d[i + 1] = 0
          d[i + 2] = 0
          d[i + 3] = 0
        } else {
          const scale = na / a
          d[i] = Math.round(d[i]! * scale)
          d[i + 1] = Math.round(d[i + 1]! * scale)
          d[i + 2] = Math.round(d[i + 2]! * scale)
          d[i + 3] = na
        }
      }
    }
  }
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3] === 0) {
      d[p] = 0
      d[p + 1] = 0
      d[p + 2] = 0
    }
  }
}

/**
 * 去掉「前景」里过小的 8-连通块（双背景边缘常留下半透明微尘，叠乘后仍略高于阈值）。
 * alphaThreshold 与主阈值一致；minArea 以下整块透明化。
 */
function removeSmallAlphaIslands(
  d: Uint8ClampedArray,
  w: number,
  h: number,
  alphaThreshold: number,
  minArea: number
): void {
  const n = w * h
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i

  const idx = (x: number, y: number) => y * w + x
  const solidAt = (ii: number) => d[ii * 4 + 3]! >= alphaThreshold

  function find(a: number): number {
    let x = a
    while (parent[x] !== x) x = parent[x]
    while (parent[a] !== a) {
      const nxt = parent[a]
      parent[a] = x
      a = nxt
    }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[rb] = ra
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y)
      if (!solidAt(i)) continue
      for (const [dx, dy] of NEIGH8) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const j = idx(nx, ny)
        if (solidAt(j)) union(i, j)
      }
    }
  }

  const sizes = new Map<number, number>()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y)
      if (!solidAt(i)) continue
      const r = find(i)
      sizes.set(r, (sizes.get(r) ?? 0) + 1)
    }
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = idx(x, y)
      if (!solidAt(i)) continue
      const r = find(i)
      if ((sizes.get(r) ?? 0) < minArea) {
        const p = i * 4
        d[p] = 0
        d[p + 1] = 0
        d[p + 2] = 0
        d[p + 3] = 0
      }
    }
  }
}

/**
 * 双背景「去背景抠图后修复」：叠加 4 次、Alpha 阈值、小岛清理；**不含** Alpha 侵蚀（侵蚀在去背页修复后由滑条单独做）。
 */
export function postProcessDoubleBackgroundMatte(source: HTMLCanvasElement): HTMLCanvasElement {
  const w = source.width
  const h = source.height
  if (w < 1 || h < 1) return source
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  if (!ctx) return source
  for (let i = 0; i < 4; i++) {
    ctx.drawImage(source, 0, 0)
  }
  const img = ctx.getImageData(0, 0, w, h)
  const d = img.data
  const alphaMin = Math.ceil(255 * 0.2)
  for (let p = 0; p < d.length; p += 4) {
    if (d[p + 3]! < alphaMin) {
      d[p] = 0
      d[p + 1] = 0
      d[p + 2] = 0
      d[p + 3] = 0
    }
  }
  const minIsland =
    w * h > 2_000_000 ? 20 : w * h > 800_000 ? 16 : 12
  removeSmallAlphaIslands(d, w, h, alphaMin, minIsland)
  ctx.putImageData(img, 0, 0)
  return out
}

/** 滑条 100 对应「贴边硬削」遍数上限（每遍只动当前最外一层，慢慢往里收） */
const EROSION_UI_MAX_FRONTIER_PASSES = 56

/**
 * 去背页「边缘侵蚀」：**贴透明边界**逐层硬削 Alpha（无模糊/无层间插值）。
 * 0–100 → 0～{@link EROSION_UI_MAX_FRONTIER_PASSES} 遍；单遍只减一层边缘若干 Alpha，避免 min 滤波一次塌整条半透明带。
 */
export function applyAlphaErosionToCanvas(source: HTMLCanvasElement, erosionUi0to100: number): HTMLCanvasElement {
  const w = source.width
  const h = source.height
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const sctx = source.getContext('2d')
  const octx = out.getContext('2d')
  if (!sctx || !octx) return source

  const img0 = sctx.getImageData(0, 0, w, h)
  const work = new Uint8ClampedArray(img0.data)
  const u = Math.min(1, Math.max(0, erosionUi0to100 / 100))
  const passes = Math.min(EROSION_UI_MAX_FRONTIER_PASSES, Math.round(u * EROSION_UI_MAX_FRONTIER_PASSES))
  erodeAlphaFrontierLayers(work, w, h, passes)
  octx.putImageData(new ImageData(work, w, h), 0, 0)
  return out
}

/** 蓝图节点：与去背页「边缘侵蚀」相同的贴边硬削，输出 PNG Blob */
export async function applyAlphaErosionToBlob(blob: Blob, erosionUi0to100: number): Promise<Blob> {
  const img = await loadImageFromBlob(blob)
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('ERR_CANVAS_2D')
  ctx.drawImage(img, 0, 0)
  const out = applyAlphaErosionToCanvas(c, erosionUi0to100)
  return new Promise((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

/** 对流水线中的 PNG（含透明）做与去背页「去背景抠图后修复」相同逻辑（无侵蚀），输出 PNG Blob */
export async function postProcessDoubleBgMatteBlob(blob: Blob): Promise<Blob> {
  const img = await loadImageFromBlob(blob)
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')
  if (!ctx) throw new Error('ERR_CANVAS_2D')
  ctx.drawImage(img, 0, 0)
  const out = postProcessDoubleBackgroundMatte(c)
  return new Promise((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

export async function doubleBackgroundMatteFromBlobs(
  blackBlob: Blob,
  whiteBlob: Blob,
  tolerance: number,
  edgeContrast: number
): Promise<Blob> {
  const [blackImg, whiteImg] = await Promise.all([
    loadImageFromBlob(blackBlob),
    loadImageFromBlob(whiteBlob),
  ])
  const canvas = processDoubleBackground(blackImg, whiteImg, tolerance, edgeContrast)
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}
