import { useEffect, useRef, useState } from 'react'
import { Button, Checkbox, InputNumber, message, Radio, Slider, Space, Tabs, Typography, Upload } from 'antd'
import { BorderOutlined, DownloadOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { useLanguage } from '../i18n/context'
import StashableImage from './StashableImage'
import StashDropZone from './StashDropZone'
import { maxSafeUpscaleForImage } from '../lib/pixellise/safeUpscale'

const { Dragger } = Upload
const { Text } = Typography

const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']
const IMAGE_MAX_MB = 20
/** 高级像素化框选：原图像素最小边长 */
const PREVIEW_SELECTION_MIN_SIDE = 24

type NaturalRect = { x: number; y: number; w: number; h: number }

function clientToNaturalPoint(img: HTMLImageElement, clientX: number, clientY: number): { nx: number; ny: number } {
  const r = img.getBoundingClientRect()
  const nw = img.naturalWidth
  const nh = img.naturalHeight
  if (nw < 1 || nh < 1 || r.width < 1 || r.height < 1) return { nx: 0, ny: 0 }
  const nx = ((clientX - r.left) / r.width) * nw
  const ny = ((clientY - r.top) / r.height) * nh
  return {
    nx: Math.max(0, Math.min(nw - 1, nx)),
    ny: Math.max(0, Math.min(nh - 1, ny)),
  }
}

function normalizeNaturalRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  nw: number,
  nh: number,
): NaturalRect {
  let x = Math.min(x0, x1)
  let y = Math.min(y0, y1)
  let w = Math.abs(x1 - x0)
  let h = Math.abs(y1 - y0)
  x = Math.floor(x)
  y = Math.floor(y)
  w = Math.ceil(w)
  h = Math.ceil(h)
  x = Math.max(0, Math.min(nw - 1, x))
  y = Math.max(0, Math.min(nh - 1, y))
  w = Math.min(w, nw - x)
  h = Math.min(h, nh - y)
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) }
}

async function cropImageFileToPngBlob(file: File, rect: NaturalRect): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image()
      i.onload = () => res(i)
      i.onerror = () => rej(new Error('load'))
      i.src = url
    })
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const x = Math.max(0, Math.min(Math.floor(rect.x), nw - 1))
    const y = Math.max(0, Math.min(Math.floor(rect.y), nh - 1))
    const w = Math.max(1, Math.min(Math.ceil(rect.w), nw - x))
    const h = Math.max(1, Math.min(Math.ceil(rect.h), nh - y))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h)
    return await new Promise<Blob>((resolve, reject) => {
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  let x = r / 255, y = g / 255, z = b / 255
  x = x > 0.04045 ? ((x + 0.055) / 1.055) ** 2.4 : x / 12.92
  y = y > 0.04045 ? ((y + 0.055) / 1.055) ** 2.4 : y / 12.92
  z = z > 0.04045 ? ((z + 0.055) / 1.055) ** 2.4 : z / 12.92
  x *= 100
  y *= 100
  z *= 100
  const l = 116 * f(y / 100) - 16
  const a = 500 * (f(x / 95.047) - f(y / 100))
  const b_ = 200 * (f(y / 100) - f(z / 108.883))
  return [l, a, b_]
}
function f(t: number): number {
  return t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116
}

/** 与上方 rgbToLab 同一套线性 RGB → Lab 定义的可逆变换 */
function fInv(ft: number): number {
  const cube = ft * ft * ft
  return cube > 0.008856 ? cube : (ft - 16 / 116) / 7.787
}

function labToRgb(l: number, a: number, b: number): [number, number, number] {
  const fy = (l + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const rLin = fInv(fx) * (95.047 / 100)
  const gLin = fInv(fy)
  const bLin = fInv(fz) * (108.883 / 100)
  const toSrgbByte = (u: number) => {
    const c = Math.max(0, Math.min(1, u))
    const x = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.max(0, Math.min(255, Math.round(x * 255)))
  }
  return [toSrgbByte(rLin), toSrgbByte(gLin), toSrgbByte(bLin)]
}

/** 在 LAB 空间按网格对齐相近颜色；strength 0～100，越大合并越强 */
function applyMergeNearbyLab(imageData: ImageData, strength: number): void {
  if (strength <= 0) return
  const t = strength / 100
  const stepL = 2 + t * 26
  const stepA = 1.5 + t * 14
  const stepB = 1.5 + t * 14
  const d = imageData.data
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3]! < 128) continue
    let [L, la, lb] = rgbToLab(d[i]!, d[i + 1]!, d[i + 2]!)
    L = Math.round(L / stepL) * stepL
    la = Math.round(la / stepA) * stepA
    lb = Math.round(lb / stepB) * stepB
    const [r, g, b] = labToRgb(L, la, lb)
    d[i] = r
    d[i + 1] = g
    d[i + 2] = b
  }
}

interface Color16Options {
  method: 'rgb' | 'lab'
  dither: boolean
}

/** 中位切分法生成 16 色调色板，再用最近邻映射输出。支持 LAB 感知距离与抖动。 */
function reduceTo16Colors(img: HTMLImageElement, opts: Color16Options): Promise<Blob> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h)
  const pixels: [number, number, number][] = []
  for (let i = 0; i < data.data.length; i += 4) {
    const a = data.data[i + 3]
    if (a < 128) continue
    pixels.push([data.data[i]!, data.data[i + 1]!, data.data[i + 2]!])
  }
  if (pixels.length === 0) pixels.push([255, 255, 255])

  const maxPixels = 10000
  const sampled = pixels.length > maxPixels
    ? pixels.filter((_, i) => i % Math.ceil(pixels.length / maxPixels) === 0)
    : pixels

  let boxes: [number, number, number][][] = [[...sampled]]
  while (boxes.length < 16) {
    let maxRange = -1
    let splitIdx = 0
    let channel = 0
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i]!
      if (box.length <= 1) continue
      const r1 = Math.max(...box.map((p) => p[0])), r0 = Math.min(...box.map((p) => p[0]))
      const g1 = Math.max(...box.map((p) => p[1])), g0 = Math.min(...box.map((p) => p[1]))
      const b1 = Math.max(...box.map((p) => p[2])), b0 = Math.min(...box.map((p) => p[2]))
      const dr = r1 - r0, dg = g1 - g0, db = b1 - b0
      const max = Math.max(dr, dg, db)
      if (max > maxRange) {
        maxRange = max
        splitIdx = i
        channel = dr >= dg && dr >= db ? 0 : dg >= db ? 1 : 2
      }
    }
    const box = boxes[splitIdx]!
    if (box.length <= 1) break
    box.sort((a, b) => a[channel] - b[channel])
    const mid = Math.floor(box.length / 2)
    const left = box.slice(0, mid)
    const right = box.slice(mid)
    boxes = [...boxes.slice(0, splitIdx), left, right, ...boxes.slice(splitIdx + 1)]
  }
  const palette: [number, number, number][] = boxes.map((box) => {
    const r = Math.round(box.reduce((s, p) => s + p[0], 0) / box.length)
    const g = Math.round(box.reduce((s, p) => s + p[1], 0) / box.length)
    const b = Math.round(box.reduce((s, p) => s + p[2], 0) / box.length)
    return [r, g, b]
  })
  while (palette.length < 16) palette.push([0, 0, 0])

  const paletteLab = opts.method === 'lab' ? palette.map((p) => rgbToLab(p[0], p[1], p[2])) : null

  function nearest([r, g, b]: [number, number, number]): [number, number, number] {
    let best = palette[0]!
    let bestD = Infinity
    if (opts.method === 'lab' && paletteLab) {
      const [l, a, b_] = rgbToLab(r, g, b)
      for (let i = 0; i < palette.length; i++) {
        const [pl, pa, pb] = paletteLab[i]!
        const d = (l - pl) ** 2 + (a - pa) ** 2 + (b_ - pb) ** 2
        if (d < bestD) {
          bestD = d
          best = palette[i]!
        }
      }
    } else {
      for (const p of palette) {
        const d = (r - p[0]) ** 2 + (g - p[1]) ** 2 + (b - p[2]) ** 2
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
    }
    return best
  }

  if (opts.dither) {
    const errBuf = new Float32Array((w + 2) * (h + 2) * 3)
    const ei = (y: number, x: number, c: number) => ((y + 1) * (w + 2) + (x + 1)) * 3 + c
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        const a = data.data[i + 3]!
        if (a < 128) {
          data.data[i] = 0
          data.data[i + 1] = 0
          data.data[i + 2] = 0
          data.data[i + 3] = 0
          continue
        }
        const r = Math.max(0, Math.min(255, data.data[i]! + errBuf[ei(y, x, 0)]))
        const g = Math.max(0, Math.min(255, data.data[i + 1]! + errBuf[ei(y, x, 1)]))
        const b = Math.max(0, Math.min(255, data.data[i + 2]! + errBuf[ei(y, x, 2)]))
        const [pr, pg, pb] = nearest([r, g, b])
        data.data[i] = pr
        data.data[i + 1] = pg
        data.data[i + 2] = pb
        const er = (r - pr) / 16
        const eg = (g - pg) / 16
        const eb = (b - pb) / 16
        errBuf[ei(y, x + 1, 0)] += er * 7
        errBuf[ei(y, x + 1, 1)] += eg * 7
        errBuf[ei(y, x + 1, 2)] += eb * 7
        errBuf[ei(y + 1, x - 1, 0)] += er * 3
        errBuf[ei(y + 1, x - 1, 1)] += eg * 3
        errBuf[ei(y + 1, x - 1, 2)] += eb * 3
        errBuf[ei(y + 1, x, 0)] += er * 5
        errBuf[ei(y + 1, x, 1)] += eg * 5
        errBuf[ei(y + 1, x, 2)] += eb * 5
        errBuf[ei(y + 1, x + 1, 0)] += er * 1
        errBuf[ei(y + 1, x + 1, 1)] += eg * 1
        errBuf[ei(y + 1, x + 1, 2)] += eb * 1
      }
    }
  } else {
    for (let i = 0; i < data.data.length; i += 4) {
      const a = data.data[i + 3]
      if (a < 128) {
        data.data[i] = 0
        data.data[i + 1] = 0
        data.data[i + 2] = 0
        data.data[i + 3] = 0
      } else {
        const [r, g, b] = nearest([data.data[i]!, data.data[i + 1]!, data.data[i + 2]!])
        data.data[i] = r
        data.data[i + 1] = g
        data.data[i + 2] = b
      }
    }
  }
  ctx.putImageData(data, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
  })
}

function pixelateImage(img: HTMLImageElement, pixelSize: number): Promise<Blob> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const block = Math.max(1, Math.floor(pixelSize))
  const scaledW = Math.max(1, Math.floor(w / block))
  const scaledH = Math.max(1, Math.floor(h / block))

  const small = document.createElement('canvas')
  small.width = scaledW
  small.height = scaledH
  small.getContext('2d')!.drawImage(img, 0, 0, w, h, 0, 0, scaledW, scaledH)

  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(small, 0, 0, scaledW, scaledH, 0, 0, w, h)
  return new Promise<Blob>((resolve, reject) => {
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
  })
}

function mergeNearbyColorsImage(img: HTMLImageElement, strength: number): Promise<Blob> {
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const imageData = ctx.getImageData(0, 0, w, h)
  applyMergeNearbyLab(imageData, strength)
  ctx.putImageData(imageData, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
  })
}

export default function ImagePixelate() {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<'pixelate' | 'mergeNearby' | 'color16' | 'advanced'>('pixelate')
  const [color16Method, setColor16Method] = useState<'rgb' | 'lab'>('lab')
  const [color16Dither, setColor16Dither] = useState(true)
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [pixelSize, setPixelSize] = useState(8)
  const [mergeNearbyStrength, setMergeNearbyStrength] = useState(40)
  const [advUpscale, setAdvUpscale] = useState(3)
  const [advUpscaleCeiling, setAdvUpscaleCeiling] = useState(7)
  const [advColors, setAdvColors] = useState(64)
  const [advScaleResult, setAdvScaleResult] = useState(1)
  const [advTransparent, setAdvTransparent] = useState(false)
  const [advStatusKey, setAdvStatusKey] = useState<string | null>(null)
  const [resultUrl, setResultUrl] = useState<string | null>(null)
  const [resultBlob, setResultBlob] = useState<Blob | null>(null)
  const [loading, setLoading] = useState(false)
  const [naturalWH, setNaturalWH] = useState<{ w: number; h: number } | null>(null)
  const [previewSelection, setPreviewSelection] = useState<NaturalRect | null>(null)
  const [previewSelectActive, setPreviewSelectActive] = useState(false)
  const [draftSelection, setDraftSelection] = useState<NaturalRect | null>(null)
  const previewImgRef = useRef<HTMLImageElement>(null)
  const selectDragRef = useRef<{ nx0: number; ny0: number } | null>(null)
  const urlsRef = useRef({ originalUrl: null as string | null, resultUrl: null as string | null })
  urlsRef.current = { originalUrl, resultUrl }

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file)
      setOriginalUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    setOriginalUrl(null)
  }, [file])

  useEffect(
    () => () => {
      if (urlsRef.current.originalUrl) URL.revokeObjectURL(urlsRef.current.originalUrl)
      if (urlsRef.current.resultUrl) URL.revokeObjectURL(urlsRef.current.resultUrl)
    },
    [],
  )

  useEffect(() => {
    setPreviewSelection(null)
    setPreviewSelectActive(false)
    setDraftSelection(null)
    selectDragRef.current = null
  }, [file])

  useEffect(() => {
    if (!file) {
      setNaturalWH(null)
      return
    }
    let cancelled = false
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      setNaturalWH({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      if (!cancelled) setNaturalWH(null)
    }
    img.src = url
    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
      URL.revokeObjectURL(url)
    }
  }, [file])

  useEffect(() => {
    if (!naturalWH) {
      setAdvUpscaleCeiling(7)
      return
    }
    const w = previewSelection?.w ?? naturalWH.w
    const h = previewSelection?.h ?? naturalWH.h
    const maxU = maxSafeUpscaleForImage(w, h)
    setAdvUpscaleCeiling(maxU)
    setAdvUpscale((prev) => Math.min(prev, maxU))
  }, [naturalWH, previewSelection])

  const updateDraftFromPointer = (clientX: number, clientY: number) => {
    const img = previewImgRef.current
    const drag = selectDragRef.current
    if (!img || !drag) return
    const { nx, ny } = clientToNaturalPoint(img, clientX, clientY)
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    setDraftSelection(normalizeNaturalRect(drag.nx0, drag.ny0, nx, ny, nw, nh))
  }

  const finishPreviewSelect = (e: React.PointerEvent, clientX: number, clientY: number) => {
    const img = previewImgRef.current
    const drag = selectDragRef.current
    if (!previewSelectActive || !img || !drag) return
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    const { nx, ny } = clientToNaturalPoint(img, clientX, clientY)
    const nw = img.naturalWidth
    const nh = img.naturalHeight
    const rect = normalizeNaturalRect(drag.nx0, drag.ny0, nx, ny, nw, nh)
    selectDragRef.current = null
    setDraftSelection(null)
    setPreviewSelectActive(false)
    if (rect.w < PREVIEW_SELECTION_MIN_SIDE || rect.h < PREVIEW_SELECTION_MIN_SIDE) {
      message.warning(t('pixelatePreviewSelectTooSmall', { n: PREVIEW_SELECTION_MIN_SIDE }))
      return
    }
    setPreviewSelection(rect)
  }

  const runPixelate = async () => {
    if (!file) return
    setLoading(true)
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setResultBlob(null)
    try {
      const url = URL.createObjectURL(file)
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('load'))
        i.src = url
      })
      URL.revokeObjectURL(url)
      const blob = await pixelateImage(img, pixelSize)
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      message.success(t('pixelateSuccess'))
    } catch (e) {
      message.error(t('pixelateFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const runAdvancedPixellise = async () => {
    if (!file) return
    if (
      previewSelection &&
      (previewSelection.w < PREVIEW_SELECTION_MIN_SIDE ||
        previewSelection.h < PREVIEW_SELECTION_MIN_SIDE)
    ) {
      message.warning(t('pixelatePreviewSelectTooSmall', { n: PREVIEW_SELECTION_MIN_SIDE }))
      return
    }
    setLoading(true)
    setAdvStatusKey(null)
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setResultBlob(null)
    try {
      let workFile: File = file
      if (previewSelection) {
        const cropped = await cropImageFileToPngBlob(file, previewSelection)
        const base = file.name.replace(/\.[^.]+$/, '') || 'region'
        workFile = new File([cropped], `${base}_region.png`, { type: 'image/png' })
      }
      const { runPixelliseRestore } = await import('../lib/pixellise/pipeline')
      const { blob, upscaleCapped, upscaleRequested, upscaleUsed } = await runPixelliseRestore(
        workFile,
        {
          upscale: advUpscale,
          numColors: advColors,
          scaleResult: advScaleResult,
          transparentBackground: advTransparent,
        },
        (key) => setAdvStatusKey(key),
      )
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      if (upscaleCapped) {
        setAdvUpscale(upscaleUsed)
        message.success(
          t('pixelateAdvancedSuccessWithCap', { from: upscaleRequested, to: upscaleUsed }),
        )
      } else {
        message.success(t('pixelateAdvancedSuccess'))
      }
    } catch (e) {
      message.error(t('pixelateAdvancedFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
      setAdvStatusKey(null)
    }
  }

  const runMergeNearby = async () => {
    if (!file) return
    if (mergeNearbyStrength <= 0) {
      message.warning(t('pixelateMergeNearbyNeedStrength'))
      return
    }
    setLoading(true)
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setResultBlob(null)
    try {
      const url = URL.createObjectURL(file)
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('load'))
        i.src = url
      })
      URL.revokeObjectURL(url)
      const blob = await mergeNearbyColorsImage(img, mergeNearbyStrength)
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      message.success(t('pixelateMergeNearbySuccess'))
    } catch (e) {
      message.error(t('pixelateMergeNearbyFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const run16Color = async () => {
    if (!file) return
    setLoading(true)
    setResultUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setResultBlob(null)
    try {
      const url = URL.createObjectURL(file)
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('load'))
        i.src = url
      })
      URL.revokeObjectURL(url)
      const blob = await reduceTo16Colors(img, { method: color16Method, dither: color16Dither })
      setResultBlob(blob)
      setResultUrl(URL.createObjectURL(blob))
      message.success(t('pixelate16ColorSuccess'))
    } catch (e) {
      message.error(t('pixelate16ColorFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const download = () => {
    if (!resultBlob) return
    const a = document.createElement('a')
    a.href = URL.createObjectURL(resultBlob)
    a.download = (file?.name?.replace(/\.[^.]+$/, '') || 'pixelated') + '.png'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <StashDropZone
        onStashDrop={(f) => {
          setFile(f)
          setResultUrl((old) => {
            if (old) URL.revokeObjectURL(old)
            return null
          })
          setResultBlob(null)
        }}
        maxSizeMB={IMAGE_MAX_MB}
        onSizeError={() => message.error(t('imageSizeError'))}
      >
        <Dragger
          accept={IMAGE_ACCEPT.join(',')}
          maxCount={1}
          fileList={file ? [{ uid: '1', name: file.name } as UploadFile] : []}
          beforeUpload={(f) => {
            if (f.size > IMAGE_MAX_MB * 1024 * 1024) {
              message.error(t('imageSizeError'))
              return false
            }
            setFile(f)
            setResultUrl((old) => {
              if (old) URL.revokeObjectURL(old)
              return null
            })
            setResultBlob(null)
            return false
          }}
          onRemove={() => setFile(null)}
        >
          <p className="ant-upload-text">{t('imageUploadHint')}</p>
          <p className="ant-upload-hint">{t('imageFormats')}</p>
        </Dragger>
      </StashDropZone>
      {file && originalUrl && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <Text strong style={{ display: 'block', marginBottom: 0 }}>{t('imgOriginalPreview')}</Text>
            <Space wrap size="small">
              <Button
                size="small"
                type={previewSelectActive ? 'primary' : 'default'}
                icon={<BorderOutlined />}
                disabled={!naturalWH}
                onClick={() => {
                  if (previewSelectActive) {
                    selectDragRef.current = null
                    setDraftSelection(null)
                  }
                  setPreviewSelectActive((a) => !a)
                }}
              >
                {previewSelectActive ? t('pixelatePreviewSelectCancel') : t('pixelatePreviewSelectStart')}
              </Button>
              <Button size="small" disabled={!previewSelection} onClick={() => setPreviewSelection(null)}>
                {t('pixelatePreviewSelectClear')}
              </Button>
            </Space>
          </div>
          {previewSelectActive && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              {t('pixelatePreviewSelectHint')}
            </Text>
          )}
          {previewSelection && !previewSelectActive && naturalWH && (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
              {t('pixelatePreviewSelectRegionInfo', {
                w: previewSelection.w,
                h: previewSelection.h,
              })}
            </Text>
          )}
          <div
            style={{
              padding: 16,
              width: '100%',
              boxSizing: 'border-box',
              background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
              borderRadius: 8,
              border: '1px solid #9a8b78',
            }}
          >
            <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', lineHeight: 0 }}>
              <StashableImage
                ref={previewImgRef}
                src={originalUrl}
                alt=""
                draggable={!previewSelectActive}
                style={{
                  maxWidth: '100%',
                  width: 'auto',
                  height: 'auto',
                  maxHeight: 440,
                  display: 'block',
                  imageRendering: 'auto',
                  verticalAlign: 'top',
                }}
              />
              {naturalWH && previewSelection && !previewSelectActive && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(previewSelection.x / naturalWH.w) * 100}%`,
                    top: `${(previewSelection.y / naturalWH.h) * 100}%`,
                    width: `${(previewSelection.w / naturalWH.w) * 100}%`,
                    height: `${(previewSelection.h / naturalWH.h) * 100}%`,
                    border: '2px solid #c2410c',
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                    background: 'rgba(194, 65, 12, 0.12)',
                  }}
                />
              )}
              {naturalWH && draftSelection && previewSelectActive && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(draftSelection.x / naturalWH.w) * 100}%`,
                    top: `${(draftSelection.y / naturalWH.h) * 100}%`,
                    width: `${(draftSelection.w / naturalWH.w) * 100}%`,
                    height: `${(draftSelection.h / naturalWH.h) * 100}%`,
                    border: '2px dashed #c2410c',
                    boxSizing: 'border-box',
                    pointerEvents: 'none',
                    background: 'rgba(194, 65, 12, 0.08)',
                  }}
                />
              )}
              <div
                role="presentation"
                style={{
                  position: 'absolute',
                  inset: 0,
                  cursor: previewSelectActive ? 'crosshair' : 'default',
                  touchAction: 'none',
                  pointerEvents: previewSelectActive ? 'auto' : 'none',
                }}
                onPointerDown={(e) => {
                  if (!previewSelectActive || !previewImgRef.current) return
                  e.preventDefault()
                  const { nx, ny } = clientToNaturalPoint(previewImgRef.current, e.clientX, e.clientY)
                  selectDragRef.current = { nx0: nx, ny0: ny }
                  e.currentTarget.setPointerCapture(e.pointerId)
                  const nw = previewImgRef.current.naturalWidth
                  const nh = previewImgRef.current.naturalHeight
                  setDraftSelection(normalizeNaturalRect(nx, ny, nx, ny, nw, nh))
                }}
                onPointerMove={(e) => {
                  if (selectDragRef.current) updateDraftFromPointer(e.clientX, e.clientY)
                }}
                onPointerUp={(e) => {
                  if (selectDragRef.current) finishPreviewSelect(e, e.clientX, e.clientY)
                }}
                onPointerCancel={(e) => {
                  selectDragRef.current = null
                  setDraftSelection(null)
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId)
                  } catch {
                    /* noop */
                  }
                }}
              />
            </div>
          </div>
        </>
      )}
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'pixelate' | 'mergeNearby' | 'color16' | 'advanced')}
        items={[
          {
            key: 'pixelate',
            label: t('pixelateTabBlock'),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block' }}>{t('pixelateHint')}</Text>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('pixelateSize')}</Text>
                  <Space wrap>
                    <Slider
                      min={2}
                      max={64}
                      value={pixelSize}
                      onChange={setPixelSize}
                      style={{ width: 200, marginRight: 16 }}
                    />
                    <InputNumber min={2} max={128} value={pixelSize} onChange={(v) => setPixelSize(v ?? 8)} style={{ width: 90 }} />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelateSizeHint')}</Text>
                </div>
              </>
            ),
          },
          {
            key: 'mergeNearby',
            label: t('pixelateTabMergeNearby'),
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Text type="secondary" style={{ display: 'block' }}>{t('pixelateMergeNearbyModuleHint')}</Text>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('pixelateMergeNearbyStrength')}</Text>
                  <Space wrap>
                    <Slider
                      min={1}
                      max={100}
                      value={mergeNearbyStrength}
                      onChange={setMergeNearbyStrength}
                      style={{ width: 200, marginRight: 16 }}
                    />
                    <InputNumber min={1} max={100} value={mergeNearbyStrength} onChange={(v) => setMergeNearbyStrength(v ?? 40)} style={{ width: 90 }} />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelateMergeNearbyHint')}</Text>
                </div>
              </Space>
            ),
          },
          {
            key: 'color16',
            label: t('pixelateTab16Color'),
            children: (
              <Space direction="vertical" size="middle">
                <Text type="secondary" style={{ display: 'block' }}>{t('pixelate16ColorHint')}</Text>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 4 }}>{t('pixelate16ColorMethod')}</Text>
                  <Radio.Group value={color16Method} onChange={(e) => setColor16Method(e.target.value)}>
                    <Radio value="rgb">{t('pixelate16ColorMethodRgb')}</Radio>
                    <Radio value="lab">{t('pixelate16ColorMethodLab')}</Radio>
                  </Radio.Group>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelate16ColorMethodLabHint')}</Text>
                </div>
                <Checkbox checked={color16Dither} onChange={(e) => setColor16Dither(e.target.checked)}>
                  {t('pixelate16ColorDither')}
                </Checkbox>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('pixelate16ColorDitherHint')}</Text>
              </Space>
            ),
          },
          {
            key: 'advanced',
            label: t('pixelateTabAdvanced'),
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                {previewSelection && (
                  <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                    {t('pixelateAdvancedRegionOnly')}
                  </Text>
                )}
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('pixelateAdvancedUpscale')}</Text>
                  <Space wrap>
                    <Slider
                      min={1}
                      max={advUpscaleCeiling}
                      step={1}
                      value={advUpscale}
                      onChange={(v) => setAdvUpscale(v as number)}
                      style={{ width: 200, marginRight: 16 }}
                    />
                    <InputNumber
                      min={1}
                      max={advUpscaleCeiling}
                      value={advUpscale}
                      onChange={(v) =>
                        setAdvUpscale(
                          Math.min(advUpscaleCeiling, Math.max(1, typeof v === 'number' ? v : 3)),
                        )
                      }
                      style={{ width: 90 }}
                    />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelateAdvancedUpscaleHint')}</Text>
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('pixelateAdvancedColors')}</Text>
                  <Space wrap>
                    <Slider
                      min={4}
                      max={64}
                      value={advColors}
                      onChange={setAdvColors}
                      style={{ width: 200, marginRight: 16 }}
                    />
                    <InputNumber min={4} max={256} value={advColors} onChange={(v) => setAdvColors(v ?? 64)} style={{ width: 90 }} />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelateAdvancedColorsHint')}</Text>
                </div>
                <div>
                  <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('pixelateAdvancedScaleResult')}</Text>
                  <Space wrap>
                    <Slider
                      min={1}
                      max={5}
                      step={1}
                      value={advScaleResult}
                      onChange={(v) => setAdvScaleResult(v as number)}
                      style={{ width: 200, marginRight: 16 }}
                    />
                    <InputNumber min={1} max={5} value={advScaleResult} onChange={(v) => setAdvScaleResult(v ?? 1)} style={{ width: 90 }} />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>{t('pixelateAdvancedScaleResultHint')}</Text>
                </div>
                <Checkbox checked={advTransparent} onChange={(e) => setAdvTransparent(e.target.checked)}>
                  {t('pixelateAdvancedTransparent')}
                </Checkbox>
                <Text type="secondary" style={{ display: 'block' }}>{t('pixelateAdvancedHint')}</Text>
                <Text type="secondary" style={{ display: 'block' }}>{t('pixelateAdvancedDesc')}</Text>
              </Space>
            ),
          },
        ]}
      />
      <Space wrap>
        {activeTab === 'pixelate' && (
          <Button type="primary" loading={loading} onClick={runPixelate} disabled={!file}>
            {t('pixelateApply')}
          </Button>
        )}
        {activeTab === 'mergeNearby' && (
          <Button type="primary" loading={loading} onClick={runMergeNearby} disabled={!file}>
            {t('pixelateMergeNearbyApply')}
          </Button>
        )}
        {activeTab === 'color16' && (
          <Button type="primary" loading={loading} onClick={run16Color} disabled={!file}>
            {t('pixelate16ColorApply')}
          </Button>
        )}
        {activeTab === 'advanced' && (
          <Button type="primary" loading={loading} onClick={runAdvancedPixellise} disabled={!file}>
            {t('pixelateAdvancedApply')}
          </Button>
        )}
        {activeTab === 'advanced' && advStatusKey && loading && (
          <Text type="secondary">{t(advStatusKey)}</Text>
        )}
        {resultUrl && (
          <Button icon={<DownloadOutlined />} onClick={download}>
            {t('imgDownload')}
          </Button>
        )}
      </Space>
      {resultUrl && (
        <>
          <Text strong style={{ display: 'block' }}>{t('imgPreview')}</Text>
          <div
            style={{
              padding: 16,
              background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
              borderRadius: 8,
              border: '1px solid #9a8b78',
              display: 'inline-block',
            }}
          >
            <StashableImage src={resultUrl} alt="" style={{ maxWidth: '100%', maxHeight: 400, display: 'block', imageRendering: 'pixelated' }} />
          </div>
        </>
      )}
    </Space>
  )
}
