import { useEffect, useState } from 'react'
import { Button, Checkbox, InputNumber, message, Slider, Space, Tabs, Typography, Upload } from 'antd'
import {
  DeleteOutlined,
  DownloadOutlined,
  FolderOpenOutlined,
  PlusOutlined,
  SaveOutlined,
  ScissorOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import type { UploadFile } from 'antd'
import JSZip from 'jszip'
import { useLanguage } from '../i18n/context'
import StashableImage from './StashableImage'
import StashDropZone from './StashDropZone'
import RoninProL7SeamPreview from './RoninProL7SeamPreview'

const { Dragger } = Upload
const { Text } = Typography

const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']
const REARRANGE_STORAGE_KEY = 'roninpro-customslice-rearrange'

/** 找出完全透明的行索引 */
function findTransparentRows(data: Uint8ClampedArray, width: number, height: number): number[] {
  const rows: number[] = []
  for (let y = 0; y < height; y++) {
    let allTransparent = true
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] !== 0) {
        allTransparent = false
        break
      }
    }
    if (allTransparent) rows.push(y)
  }
  return rows
}

/** 找出完全透明的列索引（在 y0..y1 范围内） */
function findTransparentCols(
  data: Uint8ClampedArray,
  width: number,
  y0: number,
  y1: number
): number[] {
  const cols: number[] = []
  for (let x = 0; x < width; x++) {
    let allTransparent = true
    for (let y = y0; y < y1; y++) {
      if (data[(y * width + x) * 4 + 3] !== 0) {
        allTransparent = false
        break
      }
    }
    if (allTransparent) cols.push(x)
  }
  return cols
}

function getRuns(arr: number[]): [number, number][] {
  if (arr.length === 0) return []
  const runs: [number, number][] = []
  let runStart = arr[0]!
  let runEnd = runStart
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === runEnd + 1) {
      runEnd = arr[i]!
    } else {
      runs.push([runStart, runEnd])
      runStart = arr[i]!
      runEnd = runStart
    }
  }
  runs.push([runStart, runEnd])
  return runs
}

function gapsFromRuns(runs: [number, number][], total: number): [number, number][] {
  if (runs.length === 0) return [[0, total - 1]]
  const regions: [number, number][] = []
  regions.push([0, runs[0]![0] - 1])
  for (let i = 0; i < runs.length - 1; i++) {
    regions.push([runs[i]![1] + 1, runs[i + 1]![0] - 1])
  }
  regions.push([runs[runs.length - 1]![1] + 1, total - 1])
  return regions.filter(([a, b]) => a <= b)
}

/** 基于透明行列检测，返回建议的 cols × rows（用于均匀切分） */
function detectAutoSplit(imageData: ImageData): { cols: number; rows: number } {
  const { data, width, height } = imageData
  const transparentRows = findTransparentRows(data, width, height)
  const rowRuns = getRuns(transparentRows)
  const rowRegions = gapsFromRuns(rowRuns, height)
  const transparentCols = findTransparentCols(data, width, 0, height)
  const colRuns = getRuns(transparentCols)
  const colRegions = gapsFromRuns(colRuns, width)
  const rows = Math.max(1, rowRegions.length)
  const cols = Math.max(1, colRegions.length)
  return { cols, rows }
}

interface Region {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 一行像素 Alpha 之和；越小表示该横线越像「缝」、越不容易切断肢体 */
function rowAlphaSum(data: Uint8ClampedArray, width: number, y: number): number {
  let s = 0
  const o = y * width * 4
  for (let x = 0; x < width; x++) {
    s += data[o + x * 4 + 3]!
  }
  return s
}

function colAlphaSum(data: Uint8ClampedArray, width: number, height: number, x: number): number {
  let s = 0
  for (let y = 0; y < height; y++) {
    s += data[(y * width + x) * 4 + 3]!
  }
  return s
}

/**
 * L7：在相邻两格名义分界附近做小范围搜索，取整行/整列 Alpha 和最小的切线，
 * 常用于手/尾巴伸入邻格时，避免均分线正好劈在笔画中间。
 */
function uniformRowStarts(fullH: number, rowsNum: number): number[] {
  return Array.from({ length: rowsNum + 1 }, (_, i) =>
    i === rowsNum ? fullH : Math.floor((i * fullH) / rowsNum)
  )
}

function uniformColStarts(fullW: number, colsNum: number): number[] {
  return Array.from({ length: colsNum + 1 }, (_, j) =>
    j === colsNum ? fullW : Math.floor((j * fullW) / colsNum)
  )
}

function adjustRowBoundariesL7(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  rowsNum: number,
  bandRatio = 0.25
): number[] {
  const starts: number[] = []
  for (let i = 0; i <= rowsNum; i++) {
    starts.push(Math.floor((i * height) / rowsNum))
  }
  starts[0] = 0
  starts[rowsNum] = height

  for (let i = 1; i < rowsNum; i++) {
    const yNom = starts[i]!
    const prev = starts[i - 1]!
    const next = starts[i + 1]!
    const span = next - prev
    const band = Math.max(4, Math.min(64, Math.floor(span * bandRatio)))
    const yMin = Math.max(prev + 1, yNom - band)
    const yMax = Math.min(next - 1, yNom + band)
    if (yMin >= yMax) continue
    let bestY = yNom
    let bestCost = Infinity
    for (let y = yMin; y <= yMax; y++) {
      const c = rowAlphaSum(data, width, y)
      if (c < bestCost || (c === bestCost && Math.abs(y - yNom) < Math.abs(bestY - yNom))) {
        bestCost = c
        bestY = y
      }
    }
    starts[i] = bestY
  }
  return starts
}

function adjustColBoundariesL7(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  colsNum: number,
  bandRatio = 0.25
): number[] {
  const starts: number[] = []
  for (let j = 0; j <= colsNum; j++) {
    starts.push(Math.floor((j * width) / colsNum))
  }
  starts[0] = 0
  starts[colsNum] = width

  for (let j = 1; j < colsNum; j++) {
    const xNom = starts[j]!
    const prev = starts[j - 1]!
    const next = starts[j + 1]!
    const span = next - prev
    const band = Math.max(2, Math.min(64, Math.floor(span * bandRatio)))
    const xMin = Math.max(prev + 1, xNom - band)
    const xMax = Math.min(next - 1, xNom + band)
    if (xMin >= xMax) continue
    let bestX = xNom
    let bestCost = Infinity
    for (let x = xMin; x <= xMax; x++) {
      const c = colAlphaSum(data, width, height, x)
      if (c < bestCost || (c === bestCost && Math.abs(x - xNom) < Math.abs(bestX - xNom))) {
        bestCost = c
        bestX = x
      }
    }
    starts[j] = bestX
  }
  return starts
}

/** 按已算好的横纵切线切分 */
function splitSpriteSheetWithStarts(
  img: HTMLImageElement,
  colStarts: number[],
  rowStarts: number[]
): HTMLCanvasElement[] {
  const colsNum = colStarts.length - 1
  const rowsNum = rowStarts.length - 1
  const results: HTMLCanvasElement[] = []
  for (let row = 0; row < rowsNum; row++) {
    for (let col = 0; col < colsNum; col++) {
      const sx = colStarts[col]!
      const ex = colStarts[col + 1]!
      const sy = rowStarts[row]!
      const ey = rowStarts[row + 1]!
      const w = Math.max(1, ex - sx)
      const h = Math.max(1, ey - sy)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(img, sx, sy, w, h, 0, 0, w, h)
      results.push(c)
    }
  }
  return results
}

/** 同一行带内所有竖线同时加同一 offset 时，offset 的可行区间（像素，整数） */
function bandColOffsetBounds(colStarts: number[], fullW: number): { min: number; max: number } {
  const n = colStarts.length
  if (n < 2) return { min: 0, max: 0 }
  let lo = -Infinity
  let hi = Infinity
  for (let j = 1; j < n - 1; j++) {
    lo = Math.max(lo, colStarts[j - 1]! + 1 - colStarts[j]!)
    hi = Math.min(hi, colStarts[j + 1]! - 1 - colStarts[j]!)
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return { min: 0, max: 0 }
  return { min: Math.ceil(lo), max: Math.floor(hi) }
}

function segColXWithBandOff(
  bandOff: number,
  j: number,
  colStarts: number[],
  fullW: number
): number {
  if (j <= 0) return 0
  if (j >= colStarts.length - 1) return fullW
  return colStarts[j]! + bandOff
}

/**
 * 按行带竖线整体偏移（锯齿）：第 r 行带内竖线 x = colStarts[j] + bandColOffset[r]，
 * 行带之间可在横缝处形成阶梯错位。
 */
function splitSpriteSheetWithBandOffsets(
  img: HTMLImageElement,
  colStarts: number[],
  rowStarts: number[],
  bandColOffset: number[]
): HTMLCanvasElement[] {
  const colsNum = colStarts.length - 1
  const rowsNum = rowStarts.length - 1
  if (bandColOffset.length !== rowsNum) {
    throw new Error('bandColOffset length must equal row count')
  }
  const fullW = img.naturalWidth
  const results: HTMLCanvasElement[] = []
  for (let row = 0; row < rowsNum; row++) {
    const off = bandColOffset[row] ?? 0
    for (let col = 0; col < colsNum; col++) {
      const sx = segColXWithBandOff(off, col, colStarts, fullW)
      const ex = segColXWithBandOff(off, col + 1, colStarts, fullW)
      const sy = rowStarts[row]!
      const ey = rowStarts[row + 1]!
      const w = Math.max(1, ex - sx)
      const h = Math.max(1, ey - sy)
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      c.getContext('2d')!.drawImage(img, sx, sy, w, h, 0, 0, w, h)
      results.push(c)
    }
  }
  return results
}

/** 单行条带：竖线先沿名义 x 下到拐点 y=L，再水平偏移 dx，再垂直到底；每格为七边形/梯形裁切 */
function buildStripCellVertices(
  xL: number,
  xR: number,
  L: number,
  H: number,
  dx: number
): [number, number][] {
  const Lc = Math.max(0, Math.min(H, Math.floor(L)))
  const d = Math.round(dx)
  if (Lc <= 0) {
    return [
      [xL, 0],
      [xR, 0],
      [xR + d, H],
      [xL + d, H],
    ]
  }
  if (Lc >= H) {
    return [
      [xL, 0],
      [xR, 0],
      [xR, H],
      [xL, H],
    ]
  }
  return [
    [xL, 0],
    [xR, 0],
    [xR, Lc],
    [xR + d, Lc],
    [xR + d, H],
    [xL + d, H],
    [xL, Lc],
  ]
}

/** 单行折线：水平偏移上限（避免格宽被挤没） */
function maxPolyDeltaX(colStarts: number[], fullW: number): number {
  const n = colStarts.length
  if (n < 2) return 1
  let minW = Infinity
  for (let c = 0; c < n - 1; c++) {
    minW = Math.min(minW, colStarts[c + 1]! - colStarts[c]!)
  }
  if (!Number.isFinite(minW) || minW < 1) return 1
  return Math.max(1, Math.min(Math.floor(fullW / 2) - 1, Math.floor(minW) - 1))
}

function extractPolygonFromImage(img: HTMLImageElement, verts: [number, number][]): HTMLCanvasElement {
  const xs = verts.map((v) => v[0])
  const ys = verts.map((v) => v[1])
  const minX = Math.max(0, Math.floor(Math.min(...xs)))
  const maxX = Math.min(img.naturalWidth, Math.ceil(Math.max(...xs)))
  const minY = Math.max(0, Math.floor(Math.min(...ys)))
  const maxY = Math.min(img.naturalHeight, Math.ceil(Math.max(...ys)))
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(verts[0]![0] - minX, verts[0]![1] - minY)
  for (let i = 1; i < verts.length; i++) {
    ctx.lineTo(verts[i]![0] - minX, verts[i]![1] - minY)
  }
  ctx.closePath()
  ctx.clip()
  ctx.drawImage(img, -minX, -minY)
  ctx.restore()
  return c
}

/**
 * L7 折线格裁切：拐点在条带内部时，格 = 上下两个轴对齐矩形，用两次 drawImage 1:1 拷贝，
 * 避免 polygon clip 在斜边上的抗锯齿导致拐点下方像素发糊。
 */
function extractStripCellCrisp(
  img: HTMLImageElement,
  xL: number,
  xR: number,
  bendY: number,
  fullH: number,
  deltaX: number
): HTMLCanvasElement {
  const H = fullH
  const Lc = Math.max(0, Math.min(H, Math.floor(bendY)))
  const d = Math.round(deltaX)
  const sw = xR - xL
  if (sw < 1) {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = Math.max(1, H)
    return c
  }

  if (Lc >= H) {
    const minX = Math.max(0, xL)
    const w = Math.max(1, Math.min(img.naturalWidth, xR) - minX)
    const c = document.createElement('canvas')
    c.width = w
    c.height = H
    const ctx = c.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, xL, 0, sw, H, xL - minX, 0, sw, H)
    return c
  }

  if (Lc <= 0) {
    const verts = buildStripCellVertices(xL, xR, bendY, H, deltaX)
    return extractPolygonFromImage(img, verts)
  }

  const minX = Math.max(0, Math.min(xL, xL + d, xR, xR + d))
  const maxX = Math.min(img.naturalWidth, Math.max(xL, xL + d, xR, xR + d))
  const w = Math.max(1, maxX - minX)
  const c = document.createElement('canvas')
  c.width = w
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const sh1 = Lc
  const sh2 = H - Lc
  ctx.drawImage(img, xL, 0, sw, sh1, xL - minX, 0, sw, sh1)
  ctx.drawImage(img, xL + d, Lc, sw, sh2, xL + d - minX, Lc, sw, sh2)
  return c
}

function splitSpriteSheetSingleRowPolyline(
  img: HTMLImageElement,
  colStarts: number[],
  fullH: number,
  bendY: number,
  deltaX: number
): HTMLCanvasElement[] {
  const colsNum = colStarts.length - 1
  const H = fullH
  const results: HTMLCanvasElement[] = []
  for (let col = 0; col < colsNum; col++) {
    const xL = colStarts[col]!
    const xR = colStarts[col + 1]!
    results.push(extractStripCellCrisp(img, xL, xR, bendY, H, deltaX))
  }
  return results
}

/** 网格均匀切分；可选 L7 在名义接缝附近优化横纵切线 */
function splitSpriteSheet(
  img: HTMLImageElement,
  cols: number,
  rows: number,
  l7?: ImageData | null,
  bandRatio = 0.25
): HTMLCanvasElement[] {
  const fullW = img.naturalWidth
  const fullH = img.naturalHeight
  const colsNum = Math.max(1, Math.floor(cols))
  const rowsNum = Math.max(1, Math.floor(rows))

  let colStarts: number[]
  let rowStarts: number[]
  if (
    l7 &&
    l7.width === fullW &&
    l7.height === fullH &&
    (rowsNum > 1 || colsNum > 1)
  ) {
    rowStarts = adjustRowBoundariesL7(l7.data, fullW, fullH, rowsNum, bandRatio)
    colStarts = adjustColBoundariesL7(l7.data, fullW, fullH, colsNum, bandRatio)
  } else {
    rowStarts = uniformRowStarts(fullH, rowsNum)
    colStarts = uniformColStarts(fullW, colsNum)
  }
  return splitSpriteSheetWithStarts(img, colStarts, rowStarts)
}

/** 按自定义区域切分 */
function splitByRegions(img: HTMLImageElement, regions: Region[]): HTMLCanvasElement[] {
  const results: HTMLCanvasElement[] = []
  const fullW = img.naturalWidth
  const fullH = img.naturalHeight

  for (const r of regions) {
    const x = Math.max(0, Math.floor(r.x))
    const y = Math.max(0, Math.floor(r.y))
    const w = Math.max(1, Math.min(Math.floor(r.w), fullW - x))
    const h = Math.max(1, Math.min(Math.floor(r.h), fullH - y))

    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(img, x, y, w, h, 0, 0, w, h)
    results.push(c)
  }
  return results
}

export default function RoninProCustomSlice() {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<'grid' | 'custom' | 'auto'>('auto')
  const [spriteFile, setSpriteFile] = useState<File | null>(null)
  const [spritePreviewUrl, setSpritePreviewUrl] = useState<string | null>(null)
  const [columns, setColumns] = useState(8)
  const [rows, setRows] = useState(4)
  const [regions, setRegions] = useState<Region[]>([])
  const [loading, setLoading] = useState(false)
  const [zipUrl, setZipUrl] = useState<string | null>(null)
  const [framePreviewUrls, setFramePreviewUrls] = useState<string[]>([])
  const [frameBlobUrls, setFrameBlobUrls] = useState<string[]>([])
  const [frameSizes, setFrameSizes] = useState<{ w: number; h: number }[]>([])
  const [rearrangeRows, setRearrangeRows] = useState(() => {
    try {
      const s = localStorage.getItem(REARRANGE_STORAGE_KEY)
      if (!s) return 2
      const parsed = JSON.parse(s) as { rows?: number; cols?: number; grid?: number[][] }
      return typeof parsed.rows === 'number' && parsed.rows >= 1 && parsed.rows <= 64 ? parsed.rows : 2
    } catch {
      return 2
    }
  })
  const [rearrangeCols, setRearrangeCols] = useState(() => {
    try {
      const s = localStorage.getItem(REARRANGE_STORAGE_KEY)
      if (!s) return 4
      const parsed = JSON.parse(s) as { rows?: number; cols?: number; grid?: number[][] }
      return typeof parsed.cols === 'number' && parsed.cols >= 1 && parsed.cols <= 64 ? parsed.cols : 4
    } catch {
      return 4
    }
  })
  const [rearrangeGrid, setRearrangeGrid] = useState<number[][]>(() => {
    try {
      const s = localStorage.getItem(REARRANGE_STORAGE_KEY)
      if (!s) return [[]]
      const parsed = JSON.parse(s) as { rows?: number; cols?: number; grid?: number[][] }
      const g = parsed.grid
      if (!Array.isArray(g) || g.length === 0) return [[]]
      const next = g.map((row: unknown) =>
        Array.isArray(row)
          ? row.map((v) => (typeof v === 'number' ? Math.floor(v) : 0))
          : []
      )
      return next.length > 0 ? next : [[]]
    } catch {
      return [[]]
    }
  })
  const [composedUrl, setComposedUrl] = useState<string | null>(null)
  const [expandUp, setExpandUp] = useState(0)
  const [expandDown, setExpandDown] = useState(0)
  const [expandLeft, setExpandLeft] = useState(0)
  const [expandRight, setExpandRight] = useState(0)
  const [expandMode, setExpandMode] = useState<'all' | 'heightUpOnly'>('all')
  /** L7：接缝附近沿 Alpha 低谷微调切线（网格 + 智能检测） */
  const [sliceL7, setSliceL7] = useState(false)
  /** L7 预览：用户可调切线后再 `splitSpriteSheetWithStarts` */
  const [previewRowStarts, setPreviewRowStarts] = useState<number[] | null>(null)
  const [previewColStarts, setPreviewColStarts] = useState<number[] | null>(null)
  const [previewMeta, setPreviewMeta] = useState<{
    w: number
    h: number
    cols: number
    rows: number
  } | null>(null)
  /** L7 搜索带宽度，占相邻两格合并跨度比例（%） */
  const [l7BandPercent, setL7BandPercent] = useState(25)
  /** 每行带内竖线整体 X 偏移（锯齿）；长度 = 行带数；第 0、1 带由同一控件同步 */
  const [l7BandColOffset, setL7BandColOffset] = useState<number[]>([])
  /** 单行 L7 折线：从顶到拐点的高度、拐点处水平偏移（像素，可负） */
  const [l7PolyBendY, setL7PolyBendY] = useState(32)
  const [l7PolyDeltaX, setL7PolyDeltaX] = useState(0)

  const clearL7Preview = () => {
    setPreviewRowStarts(null)
    setPreviewColStarts(null)
    setPreviewMeta(null)
    setL7BandColOffset([])
    setL7PolyBendY(32)
    setL7PolyDeltaX(0)
  }

  useEffect(() => {
    clearL7Preview()
    if (spriteFile) {
      const url = URL.createObjectURL(spriteFile)
      setSpritePreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    setSpritePreviewUrl(null)
  }, [spriteFile])

  const revokePreviews = () => {
    setFramePreviewUrls((urls) => {
      urls.forEach(URL.revokeObjectURL)
      return []
    })
    setFrameBlobUrls((urls) => {
      urls.forEach(URL.revokeObjectURL)
      return []
    })
    setZipUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setComposedUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
  }

  useEffect(() => () => revokePreviews(), [])

  useEffect(() => {
    try {
      localStorage.setItem(
        REARRANGE_STORAGE_KEY,
        JSON.stringify({
          rows: rearrangeRows,
          cols: rearrangeCols,
          grid: rearrangeGrid,
        })
      )
    } catch {
      /* ignore */
    }
  }, [rearrangeRows, rearrangeCols, rearrangeGrid])

  useEffect(() => {
    if (!spriteFile || activeTab !== 'auto') return
    if (sliceL7) return
    void runSplit()
  }, [spriteFile, activeTab, sliceL7])

  useEffect(() => {
    if (!sliceL7) clearL7Preview()
  }, [sliceL7])

  useEffect(() => {
    if (!previewMeta || !sliceL7) return
    if (activeTab === 'grid' && (columns !== previewMeta.cols || rows !== previewMeta.rows)) {
      clearL7Preview()
    }
  }, [columns, rows, activeTab, previewMeta, sliceL7])

  const setPreviewRowBoundary = (i: number, y: number) => {
    setPreviewRowStarts((prev) => {
      if (!prev) return prev
      const next = [...prev]
      const lo = next[i - 1]! + 1
      const hi = next[i + 1]! - 1
      if (lo >= hi) return prev
      next[i] = Math.max(lo, Math.min(hi, Math.floor(y)))
      return next
    })
  }

  const setPreviewColBoundary = (j: number, x: number) => {
    setPreviewColStarts((prev) => {
      if (!prev) return prev
      const next = [...prev]
      const lo = next[j - 1]! + 1
      const hi = next[j + 1]! - 1
      if (lo >= hi) return prev
      next[j] = Math.max(lo, Math.min(hi, Math.floor(x)))
      return next
    })
  }

  const setL7BandColOffsetBand = (bandIndex: number, value: number) => {
    if (!previewColStarts || !previewMeta) return
    const { min, max } = bandColOffsetBounds(previewColStarts, previewMeta.w)
    const v = Math.max(min, Math.min(max, Math.floor(value)))
    const rowsN = previewMeta.rows
    setL7BandColOffset((prev) => {
      const next = Array.from({ length: rowsN }, (_, i) => prev[i] ?? 0)
      if (rowsN >= 2 && (bandIndex === 0 || bandIndex === 1)) {
        next[0] = v
        next[1] = v
      } else {
        next[bandIndex] = v
      }
      return next
    })
  }

  const computeL7Preview = async (mode: 'l7' | 'uniform') => {
    if (!spriteFile) return
    setLoading(true)
    try {
      const buf = await spriteFile.arrayBuffer()
      const url = URL.createObjectURL(new Blob([buf]))
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('load'))
        i.src = url
      })
      URL.revokeObjectURL(url)

      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(img, 0, 0)
      const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height)

      let colsC = columns
      let rowsC = rows
      if (activeTab === 'auto') {
        const d = detectAutoSplit(srcData)
        colsC = d.cols
        rowsC = d.rows
        setColumns(d.cols)
        setRows(d.rows)
      }

      const br = l7BandPercent / 100
      let rowStarts: number[]
      let colStarts: number[]
      if (rowsC === 1) {
        rowStarts = [0, img.naturalHeight]
        colStarts = uniformColStarts(img.naturalWidth, colsC)
        setL7PolyBendY(Math.floor(img.naturalHeight / 2))
        setL7PolyDeltaX(0)
      } else if (mode === 'uniform') {
        rowStarts = uniformRowStarts(img.naturalHeight, rowsC)
        colStarts = uniformColStarts(img.naturalWidth, colsC)
      } else {
        rowStarts = adjustRowBoundariesL7(srcData.data, img.naturalWidth, img.naturalHeight, rowsC, br)
        colStarts = adjustColBoundariesL7(srcData.data, img.naturalWidth, img.naturalHeight, colsC, br)
      }

      setPreviewRowStarts(rowStarts)
      setPreviewColStarts(colStarts)
      setPreviewMeta({
        w: img.naturalWidth,
        h: img.naturalHeight,
        cols: colsC,
        rows: rowsC,
      })
      setL7BandColOffset(Array.from({ length: rowsC }, () => 0))
      message.success(t('roninProCustomSliceL7PreviewDone'))
    } catch (e) {
      message.error(String(e))
    } finally {
      setLoading(false)
    }
  }

  const addRegion = () => {
    setRegions((prev) => [
      ...prev,
      { id: `r-${Date.now()}`, x: 0, y: 0, w: 32, h: 32 },
    ])
  }

  const updateRegion = (id: string, field: keyof Region, value: number) => {
    if (field === 'id') return
    setRegions((prev) =>
      prev.map((r) => (r.id === id ? { ...r, [field]: value } : r))
    )
  }

  const removeRegion = (id: string) => {
    setRegions((prev) => prev.filter((r) => r.id !== id))
  }

  const runSplit = async () => {
    if (!spriteFile) return
    setLoading(true)
    revokePreviews()
    try {
      const buf = await spriteFile.arrayBuffer()
      const url = URL.createObjectURL(new Blob([buf]))
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image()
        i.onload = () => res(i)
        i.onerror = () => rej(new Error('load'))
        i.src = url
      })
      URL.revokeObjectURL(url)

      let frames: HTMLCanvasElement[]
      if (activeTab === 'custom') {
        frames = splitByRegions(img, regions)
      } else if (sliceL7) {
        if (
          !previewRowStarts ||
          !previewColStarts ||
          !previewMeta ||
          previewMeta.w !== img.naturalWidth ||
          previewMeta.h !== img.naturalHeight
        ) {
          message.warning(t('roninProCustomSliceL7NeedPreview'))
          setLoading(false)
          return
        }
        if (activeTab === 'grid' && (previewMeta.cols !== columns || previewMeta.rows !== rows)) {
          message.warning(t('roninProCustomSliceL7PreviewStale'))
          setLoading(false)
          return
        }
        if (previewMeta.rows === 1) {
          frames = splitSpriteSheetSingleRowPolyline(
            img,
            previewColStarts,
            previewMeta.h,
            l7PolyBendY,
            l7PolyDeltaX
          )
        } else {
          if (
            l7BandColOffset.length !== previewMeta.rows ||
            l7BandColOffset.length !== previewRowStarts.length - 1
          ) {
            message.warning(t('roninProCustomSliceL7NeedPreview'))
            setLoading(false)
            return
          }
          frames = splitSpriteSheetWithBandOffsets(
            img,
            previewColStarts,
            previewRowStarts,
            l7BandColOffset
          )
        }
        if (activeTab === 'auto') {
          message.success(
            t('roninProCustomSliceAutoDetected', {
              cols: previewMeta.cols,
              rows: previewMeta.rows,
              n: frames.length,
            })
          )
        }
      } else if (activeTab === 'auto') {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const srcData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const { cols, rows: r0 } = detectAutoSplit(srcData)
        setColumns(cols)
        setRows(r0)
        frames = splitSpriteSheet(img, cols, r0, null)
        message.success(t('roninProCustomSliceAutoDetected', { cols, rows: r0, n: frames.length }))
      } else {
        frames = splitSpriteSheet(img, columns, rows, null)
      }

      if (frames.length === 0) {
        message.warning(t('roninProCustomSliceNoFrames'))
        setLoading(false)
        return
      }

      const zip = new JSZip()
      const allBlobUrls: string[] = []
      const sizes: { w: number; h: number }[] = []
      const previewUrls: string[] = []
      const maxPreview = 24
      for (let i = 0; i < frames.length; i++) {
        const blob = await new Promise<Blob>((resolve, reject) => {
          frames[i].toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
        })
        zip.file(`frame_${String(i).padStart(3, '0')}.png`, blob)
        const url = URL.createObjectURL(blob)
        allBlobUrls.push(url)
        sizes.push({ w: frames[i].width, h: frames[i].height })
        if (previewUrls.length < maxPreview) {
          previewUrls.push(url)
        }
      }
      setFrameBlobUrls(allBlobUrls)
      setFrameSizes(sizes)
      setFramePreviewUrls(previewUrls)
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      setZipUrl(URL.createObjectURL(zipBlob))
      const r =
        activeTab === 'custom'
          ? Math.max(1, Math.ceil(Math.sqrt(frames.length)))
          : sliceL7 && previewMeta
            ? previewMeta.rows
            : rows
      const c =
        activeTab === 'custom'
          ? Math.ceil(frames.length / r)
          : sliceL7 && previewMeta
            ? previewMeta.cols
            : columns
      setRearrangeRows(r)
      setRearrangeCols(c)
      const grid: number[][] = []
      let idx = 1
      for (let row = 0; row < r; row++) {
        const rowData: number[] = []
        for (let col = 0; col < c; col++) {
          rowData.push(idx <= frames.length ? idx : 0)
          idx++
        }
        grid.push(rowData)
      }
      setRearrangeGrid(grid)
      if (activeTab !== 'auto') {
        message.success(t('spriteSplitSuccess', { n: frames.length }))
      }
    } catch (e) {
      message.error(t('spriteSplitFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const downloadZip = () => {
    if (!zipUrl) return
    const a = document.createElement('a')
    a.href = zipUrl
    a.download = (spriteFile?.name?.replace(/\.[^.]+$/, '') || 'slices') + '_frames.zip'
    a.click()
  }

  const updateRearrangeGridSize = (newRows: number, newCols: number) => {
    setRearrangeGrid((prev) => {
      const next: number[][] = []
      const maxVal = frameBlobUrls.length
      for (let row = 0; row < newRows; row++) {
        const rowData: number[] = []
        for (let col = 0; col < newCols; col++) {
          const v = prev[row]?.[col]
          const valid = v !== undefined && v >= -maxVal && v <= maxVal && v !== 0
          rowData.push(valid ? v! : 0)
        }
        next.push(rowData)
      }
      return next
    })
  }

  const setRearrangeRowsAndResize = (v: number) => {
    const r = Math.max(1, Math.min(64, v))
    setRearrangeRows(r)
    updateRearrangeGridSize(r, rearrangeCols)
  }

  const setRearrangeColsAndResize = (v: number) => {
    const c = Math.max(1, Math.min(64, v))
    setRearrangeCols(c)
    updateRearrangeGridSize(rearrangeRows, c)
  }

  const saveRearrangeToTxt = () => {
    const data = JSON.stringify(
      { rows: rearrangeRows, cols: rearrangeCols, grid: rearrangeGrid },
      null,
      2
    )
    const blob = new Blob([data], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'rearrange_params.txt'
    a.click()
    URL.revokeObjectURL(url)
    message.success(t('roninProCustomSliceRearrangeSaveSuccess'))
  }

  const loadRearrangeFromTxt = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.txt,text/plain'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const parsed = JSON.parse(text) as {
          rows?: number
          cols?: number
          grid?: number[][]
        }
        const r = Math.max(1, Math.min(64, parsed.rows ?? 2))
        const c = Math.max(1, Math.min(64, parsed.cols ?? 4))
        const raw = Array.isArray(parsed.grid)
          ? parsed.grid.map((row: unknown) =>
              Array.isArray(row)
                ? row.map((v) => (typeof v === 'number' ? Math.floor(v) : 0))
                : []
            )
          : []
        const trimmed: number[][] = []
        for (let row = 0; row < r; row++) {
          const rowData: number[] = []
          for (let col = 0; col < c; col++) {
            const v = raw[row]?.[col]
            rowData.push(v !== undefined ? v : 0)
          }
          trimmed.push(rowData)
        }
        setRearrangeRows(r)
        setRearrangeCols(c)
        setRearrangeGrid(trimmed.length > 0 ? trimmed : [[]])
        message.success(t('roninProCustomSliceRearrangeLoadSuccess'))
      } catch {
        message.error(t('roninProCustomSliceRearrangeLoadFailed'))
      }
    }
    input.click()
  }

  const setGridCell = (row: number, col: number, value: number) => {
    const maxVal = frameBlobUrls.length
    setRearrangeGrid((prev) => {
      const next = prev.map((r) => [...r])
      if (!next[row]) next[row] = []
      const v = Math.floor(value)
      const clamped = Math.max(-maxVal, Math.min(maxVal, v))
      next[row]![col] = clamped === 0 ? 0 : clamped
      return next
    })
  }

  const runCompose = async () => {
    if (frameBlobUrls.length === 0 || frameSizes.length === 0) return
    setComposedUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    const cellW = Math.max(...frameSizes.map((s) => s.w))
    const cellH = Math.max(...frameSizes.map((s) => s.h))
    const paddedCellW = cellW + expandLeft + expandRight
    const paddedCellH = cellH + expandUp + expandDown
    const outW = rearrangeCols * paddedCellW
    const outH = rearrangeRows * paddedCellH
    const canvas = document.createElement('canvas')
    canvas.width = outW
    canvas.height = outH
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    const loadImage = (url: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const img = new Image()
        img.onload = () => res(img)
        img.onerror = () => rej(new Error('load'))
        img.src = url
      })

    const cellBuf = document.createElement('canvas')
    cellBuf.width = cellW
    cellBuf.height = cellH
    const cctx = cellBuf.getContext('2d')!
    cctx.imageSmoothingEnabled = false

    try {
      for (let row = 0; row < rearrangeRows; row++) {
        for (let col = 0; col < rearrangeCols; col++) {
          const val = rearrangeGrid[row]?.[col] ?? 0
          const absVal = Math.abs(val)
          if (absVal === 0 || absVal > frameBlobUrls.length) continue
          const img = await loadImage(frameBlobUrls[absVal - 1]!)
          const dx = col * paddedCellW + expandLeft
          const dy = row * paddedCellH + expandUp
          const flipH = val < 0
          const w = img.naturalWidth
          const h = img.naturalHeight
          cctx.clearRect(0, 0, cellW, cellH)
          const px = Math.max(0, cellW - w)
          const py = Math.max(0, Math.floor((cellH - h) / 2))
          cctx.drawImage(img, 0, 0, w, h, px, py, w, h)
          if (flipH) {
            ctx.save()
            ctx.translate(dx + cellW, dy)
            ctx.scale(-1, 1)
            ctx.drawImage(cellBuf, 0, 0, cellW, cellH, 0, 0, cellW, cellH)
            ctx.restore()
          } else {
            ctx.drawImage(cellBuf, dx, dy)
          }
        }
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png', 0.95)
      })
      setComposedUrl(URL.createObjectURL(blob))
      message.success(t('roninProCustomSliceComposed'))
    } catch (e) {
      message.error(t('roninProCustomSliceComposeFailed') + ': ' + String(e))
    }
  }

  const downloadComposed = () => {
    if (!composedUrl) return
    const a = document.createElement('a')
    a.href = composedUrl
    a.download = (spriteFile?.name?.replace(/\.[^.]+$/, '') || 'slices') + '_composed.png'
    a.click()
    message.success(t('downloadStarted'))
  }

  const applyExpandPreset = (targetW: number, targetH?: number) => {
    if (frameSizes.length === 0) return
    const cellW = Math.max(...frameSizes.map((s) => s.w))
    const cellH = Math.max(...frameSizes.map((s) => s.h))
    const w = targetH === undefined ? targetW : targetW
    const h = targetH === undefined ? targetW : targetH
    const addW = Math.max(0, w - cellW)
    const addH = Math.max(0, h - cellH)
    setExpandLeft(Math.ceil(addW / 2))
    setExpandRight(Math.floor(addW / 2))
    if (expandMode === 'heightUpOnly') {
      setExpandUp(addH)
      setExpandDown(0)
    } else {
      setExpandUp(Math.ceil(addH / 2))
      setExpandDown(Math.floor(addH / 2))
    }
  }

  const cellW = frameSizes.length > 0 ? Math.max(...frameSizes.map((s) => s.w)) : 0
  const cellH = frameSizes.length > 0 ? Math.max(...frameSizes.map((s) => s.h)) : 0
  const paddedCellW = cellW + expandLeft + expandRight
  const paddedCellH = cellH + expandUp + expandDown
  const composedOutW = rearrangeCols * paddedCellW
  const composedOutH = rearrangeRows * paddedCellH

  const showL7SeamCanvas =
    Boolean(
      spriteFile &&
        sliceL7 &&
        activeTab !== 'custom' &&
        previewMeta &&
        previewRowStarts &&
        previewColStarts &&
        spritePreviewUrl
    )

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Text type="secondary">{t('roninProCustomSliceHint')}</Text>

      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'grid' | 'custom' | 'auto')}
        items={[
          {
            key: 'auto',
            label: (
              <span>
                <ThunderboltOutlined /> {t('roninProCustomSliceAuto')}
              </span>
            ),
            children: (
              <Space direction="vertical">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('roninProCustomSliceAutoHint')}
                </Text>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {t('roninProCustomSliceAutoDetectHint')}
                </Text>
              </Space>
            ),
          },
          {
            key: 'grid',
            label: (
              <span>
                <ScissorOutlined /> {t('roninProCustomSliceGrid')}
              </span>
            ),
            children: (
              <Space direction="vertical">
                <Space wrap>
                  <span>
                    <Text type="secondary">{t('spriteColumns')}:</Text>
                    <InputNumber
                      min={1}
                      max={64}
                      value={columns}
                      onChange={(v) => setColumns(v ?? 8)}
                      style={{ width: 80, marginLeft: 8 }}
                    />
                  </span>
                  <span>
                    <Text type="secondary">{t('spriteRows')}:</Text>
                    <InputNumber
                      min={1}
                      max={64}
                      value={rows}
                      onChange={(v) => setRows(v ?? 4)}
                      style={{ width: 80, marginLeft: 8 }}
                    />
                  </span>
                </Space>
              </Space>
            ),
          },
          {
            key: 'custom',
            label: (
              <span>
                <ScissorOutlined /> {t('roninProCustomSliceRegions')}
              </span>
            ),
            children: (
              <Space direction="vertical" style={{ width: '100%' }}>
                <Button type="dashed" icon={<PlusOutlined />} onClick={addRegion}>
                  {t('roninProCustomSliceAddRegion')}
                </Button>
                {regions.length === 0 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('roninProCustomSliceAddRegionHint')}
                  </Text>
                )}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {regions.map((r) => (
                    <div
                      key={r.id}
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        alignItems: 'center',
                        padding: 8,
                        background: 'rgba(0,0,0,0.04)',
                        borderRadius: 8,
                      }}
                    >
                      <InputNumber
                        size="small"
                        addonBefore="X"
                        value={r.x}
                        min={0}
                        onChange={(v) => updateRegion(r.id, 'x', v ?? 0)}
                        style={{ width: 90 }}
                      />
                      <InputNumber
                        size="small"
                        addonBefore="Y"
                        value={r.y}
                        min={0}
                        onChange={(v) => updateRegion(r.id, 'y', v ?? 0)}
                        style={{ width: 90 }}
                      />
                      <InputNumber
                        size="small"
                        addonBefore="W"
                        value={r.w}
                        min={1}
                        onChange={(v) => updateRegion(r.id, 'w', v ?? 32)}
                        style={{ width: 90 }}
                      />
                      <InputNumber
                        size="small"
                        addonBefore="H"
                        value={r.h}
                        min={1}
                        onChange={(v) => updateRegion(r.id, 'h', v ?? 32)}
                        style={{ width: 90 }}
                      />
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={() => removeRegion(r.id)}
                      />
                    </div>
                  ))}
                </div>
              </Space>
            ),
          },
        ]}
      />

      <StashDropZone
        onStashDrop={(f) => {
          setSpriteFile(f)
          revokePreviews()
        }}
      >
        <Dragger
          accept={IMAGE_ACCEPT.join(',')}
          maxCount={1}
          fileList={spriteFile ? [{ uid: '1', name: spriteFile.name } as UploadFile] : []}
          beforeUpload={(f) => {
            setSpriteFile(f)
            revokePreviews()
            return false
          }}
          onRemove={() => setSpriteFile(null)}
        >
          <p className="ant-upload-text">{t('spriteUploadHint')}</p>
        </Dragger>
      </StashDropZone>

      {spriteFile && activeTab !== 'custom' && (
        <div>
          <Checkbox checked={sliceL7} onChange={(e) => setSliceL7(e.target.checked)}>
            {t('roninProCustomSliceL7')}
          </Checkbox>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, paddingLeft: 24, marginTop: 2 }}>
            {t('roninProCustomSliceL7Hint')}
          </Text>
        </div>
      )}

      {spriteFile && spritePreviewUrl && !showL7SeamCanvas && (
        <>
          <Text strong>{t('imgOriginalPreview')}</Text>
          <div
            style={{
              padding: 16,
              background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
              borderRadius: 8,
              border: '1px solid #9a8b78',
              display: 'inline-block',
            }}
          >
            <StashableImage
              src={spritePreviewUrl}
              alt=""
              style={{ maxWidth: 320, maxHeight: 240, display: 'block', imageRendering: 'pixelated' }}
            />
          </div>
        </>
      )}

      {spriteFile && sliceL7 && activeTab !== 'custom' && (
        <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 960 }}>
          <Text strong>{t('roninProCustomSliceL7PreviewTitle')}</Text>
          {(!previewMeta || previewMeta.rows !== 1) && (
            <div>
              <Text type="secondary" style={{ fontSize: 12, marginRight: 8 }}>
                {t('roninProCustomSliceL7Band')}
              </Text>
              <Slider
                min={10}
                max={50}
                step={1}
                value={l7BandPercent}
                onChange={setL7BandPercent}
                style={{ maxWidth: 280 }}
                tooltip={{ formatter: (v) => `${v}%` }}
              />
            </div>
          )}
          <Space wrap>
            <Button loading={loading} onClick={() => void computeL7Preview('l7')}>
              {t('roninProCustomSliceL7PreviewL7')}
            </Button>
            <Button loading={loading} onClick={() => void computeL7Preview('uniform')}>
              {t('roninProCustomSliceL7PreviewUniform')}
            </Button>
          </Space>
          {previewMeta && previewRowStarts && previewColStarts && spritePreviewUrl && (
            <>
              <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                {previewMeta.rows === 1
                  ? t('roninProCustomSliceL7PolySeamHint')
                  : t('roninProCustomSliceL7StraightSeams')}
              </Text>
              {previewMeta.rows > 1 && (
                <Text type="warning" style={{ fontSize: 12, display: 'block' }}>
                  {t('roninProCustomSliceL7PolyMultiRowWarn')}
                </Text>
              )}
              {previewMeta.rows === 1 &&
                (l7PolyBendY <= 0 || l7PolyBendY >= previewMeta.h) && (
                  <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
                    {t('roninProCustomSliceL7PolyBendRangeHint')}
                  </Text>
                )}
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>
                {previewMeta.rows === 1
                  ? t('roninProCustomSliceL7PolyDragHint')
                  : t('roninProCustomSliceL7DragHint')}
              </Text>
              <RoninProL7SeamPreview
                imageUrl={spritePreviewUrl}
                imageW={previewMeta.w}
                imageH={previewMeta.h}
                rowStarts={previewRowStarts}
                colStarts={previewColStarts}
                bandColOffset={l7BandColOffset}
                singleRowPolyline={
                  previewMeta.rows === 1
                    ? { bendY: l7PolyBendY, deltaX: l7PolyDeltaX }
                    : undefined
                }
                onRowBoundaryChange={setPreviewRowBoundary}
                onColBoundaryChange={setPreviewColBoundary}
              />
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {previewMeta.rows === 1 &&
                  (() => {
                    const dxMax = maxPolyDeltaX(previewColStarts, previewMeta.w)
                    const bendY = Math.max(0, Math.min(previewMeta.h, Math.round(l7PolyBendY)))
                    const deltaX = Math.max(-dxMax, Math.min(dxMax, Math.round(l7PolyDeltaX)))
                    return (
                      <Space
                        direction="vertical"
                        size="small"
                        style={{ width: '100%', maxWidth: 640, marginBottom: 12 }}
                      >
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t('roninProCustomSliceL7PolyParamsTitle')}
                        </Text>
                        <div style={{ width: '100%' }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 6,
                            }}
                          >
                            <Text type="secondary" style={{ fontSize: 11, flex: '1 1 200px' }}>
                              {t('roninProCustomSliceL7PolyBendY')}
                            </Text>
                            <InputNumber
                              size="small"
                              min={0}
                              max={previewMeta.h}
                              value={bendY}
                              onChange={(v) => v != null && setL7PolyBendY(Math.round(v))}
                              style={{ width: 96 }}
                            />
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t('roninProCustomSliceL7PolyBendLimit', { h: previewMeta.h })}
                            </Text>
                          </div>
                          <Slider
                            min={0}
                            max={previewMeta.h}
                            step={1}
                            value={bendY}
                            onChange={(v) => setL7PolyBendY(v)}
                            tooltip={{ formatter: (n) => `${n}px` }}
                          />
                        </div>
                        <div style={{ width: '100%' }}>
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                              flexWrap: 'wrap',
                              marginBottom: 6,
                            }}
                          >
                            <Text type="secondary" style={{ fontSize: 11, flex: '1 1 200px' }}>
                              {t('roninProCustomSliceL7PolyDeltaX')}
                            </Text>
                            <InputNumber
                              size="small"
                              min={-dxMax}
                              max={dxMax}
                              value={deltaX}
                              onChange={(v) =>
                                v != null &&
                                setL7PolyDeltaX(
                                  Math.max(-dxMax, Math.min(dxMax, Math.round(v)))
                                )
                              }
                              style={{ width: 96 }}
                            />
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t('roninProCustomSliceL7PolyDeltaLimit', { m: dxMax })}
                            </Text>
                          </div>
                          <Slider
                            min={-dxMax}
                            max={dxMax}
                            step={1}
                            value={deltaX}
                            onChange={(v) =>
                              setL7PolyDeltaX(
                                Math.max(-dxMax, Math.min(dxMax, Math.round(v)))
                              )
                            }
                            tooltip={{ formatter: (n) => `${n}px` }}
                          />
                        </div>
                      </Space>
                    )
                  })()}
                {previewRowStarts.length > 2 && (
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {t('roninProCustomSliceL7AdjustH')}
                  </Text>
                )}
                {previewRowStarts.slice(1, -1).map((y, idx) => {
                  const i = idx + 1
                  const lo = previewRowStarts[i - 1]! + 1
                  const hi = previewRowStarts[i + 1]! - 1
                  return (
                    <div key={`rh-${i}`} style={{ width: '100%', maxWidth: 640 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                        <Text type="secondary" style={{ fontSize: 12, minWidth: 72 }}>
                          {t('roninProCustomSliceL7HLine', { i: i + 1 })}
                        </Text>
                        <InputNumber
                          size="small"
                          min={lo}
                          max={hi}
                          value={y}
                          onChange={(v) => v != null && setPreviewRowBoundary(i, v)}
                          style={{ width: 88 }}
                        />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          Y px ({lo}–{hi})
                        </Text>
                      </div>
                      {lo < hi && (
                        <Slider
                          min={lo}
                          max={hi}
                          value={y}
                          onChange={(v) => setPreviewRowBoundary(i, v)}
                          tooltip={{ formatter: (n) => `${n}` }}
                        />
                      )}
                    </div>
                  )
                })}
                {previewColStarts.length > 2 && (
                  <Text type="secondary" style={{ fontSize: 12, marginTop: 4 }}>
                    {t('roninProCustomSliceL7AdjustV')}
                  </Text>
                )}
                {previewColStarts.slice(1, -1).map((x, idx) => {
                  const j = idx + 1
                  const lo = previewColStarts[j - 1]! + 1
                  const hi = previewColStarts[j + 1]! - 1
                  return (
                    <div key={`cv-${j}`} style={{ width: '100%', maxWidth: 640 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                        <Text type="secondary" style={{ fontSize: 12, minWidth: 72 }}>
                          {t('roninProCustomSliceL7VLine', { j: j + 1 })}
                        </Text>
                        <InputNumber
                          size="small"
                          min={lo}
                          max={hi}
                          value={x}
                          onChange={(v) => v != null && setPreviewColBoundary(j, v)}
                          style={{ width: 88 }}
                        />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          X px ({lo}–{hi})
                        </Text>
                      </div>
                      {lo < hi && (
                        <Slider
                          min={lo}
                          max={hi}
                          value={x}
                          onChange={(v) => setPreviewColBoundary(j, v)}
                          tooltip={{ formatter: (n) => `${n}` }}
                        />
                      )}
                    </div>
                  )
                })}
                {previewMeta.rows > 1 &&
                  l7BandColOffset.length === previewMeta.rows &&
                  (() => {
                    const b = bandColOffsetBounds(previewColStarts, previewMeta.w)
                    const rowsN = previewMeta.rows
                    if (b.min > b.max) return null
                    return (
                      <Space direction="vertical" size="small" style={{ width: '100%', maxWidth: 640, marginTop: 8 }}>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {t('roninProCustomSliceL7JaggedTitle')}
                        </Text>
                        {rowsN === 2 && (
                          <>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t('roninProCustomSliceL7Band01Sync')}
                            </Text>
                            <Slider
                              min={b.min}
                              max={b.max}
                              value={l7BandColOffset[0] ?? 0}
                              onChange={(v) => setL7BandColOffsetBand(0, v)}
                              tooltip={{ formatter: (n) => `${n}px` }}
                            />
                          </>
                        )}
                        {rowsN >= 3 && (
                          <>
                            <Text type="secondary" style={{ fontSize: 11 }}>
                              {t('roninProCustomSliceL7Band01Sync')}
                            </Text>
                            <Slider
                              min={b.min}
                              max={b.max}
                              value={l7BandColOffset[0] ?? 0}
                              onChange={(v) => setL7BandColOffsetBand(0, v)}
                              tooltip={{ formatter: (n) => `${n}px` }}
                            />
                            {Array.from({ length: rowsN - 2 }, (_, k) => k + 2).map((bandIdx) => (
                              <div key={`jag-${bandIdx}`} style={{ width: '100%' }}>
                                <Text type="secondary" style={{ fontSize: 11 }}>
                                  {t('roninProCustomSliceL7BandSegOffset', { n: bandIdx + 1 })}
                                </Text>
                                <Slider
                                  min={b.min}
                                  max={b.max}
                                  value={l7BandColOffset[bandIdx] ?? 0}
                                  onChange={(v) => setL7BandColOffsetBand(bandIdx, v)}
                                  tooltip={{ formatter: (n) => `${n}px` }}
                                />
                              </div>
                            ))}
                          </>
                        )}
                      </Space>
                    )
                  })()}
              </Space>
            </>
          )}
        </Space>
      )}

      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space>
        <Button
          type="primary"
          loading={loading}
          onClick={runSplit}
          disabled={
            !spriteFile ||
            (activeTab === 'custom' && regions.length === 0)
          }
        >
          {sliceL7 && activeTab !== 'custom'
            ? t('roninProCustomSliceL7ApplySplit')
            : activeTab === 'auto'
              ? t('roninProCustomSliceAutoSplit')
              : t('spriteSplit')}
        </Button>
        {zipUrl && (
          <Button icon={<DownloadOutlined />} onClick={downloadZip}>
            {t('gifDownloadFrames')}
          </Button>
        )}
        </Space>
      </Space>

      {framePreviewUrls.length > 0 && (
        <>
          <Text strong>{t('imgPreview')} ({t('roninProCustomSliceFrameIndex')}: 1~{frameBlobUrls.length}, 0={t('roninProCustomSliceTransparent')}, {t('roninProCustomSliceFrameIndexFlipHint')})</Text>
          <div
            style={{
              padding: 16,
              background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
              borderRadius: 8,
              border: '1px solid #9a8b78',
              display: 'inline-block',
              maxWidth: '100%',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 8,
                maxHeight: 320,
                overflow: 'auto',
              }}
            >
              {framePreviewUrls.map((url, i) => (
                <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                  <StashableImage
                    src={url}
                    alt={`frame ${i}`}
                    style={{
                      width: 48,
                      height: 48,
                      objectFit: 'contain',
                      imageRendering: 'pixelated',
                    }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      left: 2,
                      top: 2,
                      fontSize: 10,
                      fontWeight: 'bold',
                      color: '#fff',
                      textShadow: '0 0 2px #000, 0 0 2px #000',
                    }}
                  >
                    {i + 1}
                  </span>
                </div>
              ))}
              {frameBlobUrls.length > 24 && (
                <span style={{ alignSelf: 'center', color: '#999', fontSize: 12 }}>
                  ... +{frameBlobUrls.length - 24}
                </span>
              )}
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <Text strong>{t('roninProCustomSliceRearrange')}</Text>
            <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16 }}>
              <span>
                <Text type="secondary">{t('roninProCustomSliceRearrangeRows')}:</Text>
                <InputNumber
                  min={1}
                  max={64}
                  value={rearrangeRows}
                  onChange={(v) => setRearrangeRowsAndResize(v ?? 1)}
                  style={{ width: 64, marginLeft: 8 }}
                />
              </span>
              <span>
                <Text type="secondary">{t('roninProCustomSliceRearrangeCols')}:</Text>
                <InputNumber
                  min={1}
                  max={64}
                  value={rearrangeCols}
                  onChange={(v) => setRearrangeColsAndResize(v ?? 1)}
                  style={{ width: 64, marginLeft: 8 }}
                />
              </span>
              <Button icon={<SaveOutlined />} onClick={saveRearrangeToTxt}>
                {t('roninProCustomSliceRearrangeSaveToTxt')}
              </Button>
              <Button icon={<FolderOpenOutlined />} onClick={loadRearrangeFromTxt}>
                {t('roninProCustomSliceRearrangeLoadFromTxt')}
              </Button>
              <Button type="primary" onClick={runCompose}>
                {t('roninProCustomSliceCompose')}
              </Button>
              {composedUrl && (
                <Button icon={<DownloadOutlined />} onClick={downloadComposed}>
                  {t('roninProCustomSliceDownloadComposed')}
                </Button>
              )}
            </div>
            <div style={{ marginTop: 8, overflowX: 'auto' }}>
              <table
                style={{
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  background: '#fff',
                  border: '1px solid #d9d9d9',
                }}
              >
                <tbody>
                  {rearrangeGrid.map((rowData, row) => (
                    <tr key={row}>
                      {rowData.map((val, col) => (
                        <td
                          key={col}
                          style={{
                            border: '1px solid #d9d9d9',
                            padding: 2,
                          }}
                        >
                          <InputNumber
                            size="small"
                            min={-frameBlobUrls.length}
                            max={frameBlobUrls.length}
                            value={val}
                            onChange={(v) => setGridCell(row, col, v ?? 0)}
                            style={{ width: 52 }}
                            placeholder="0"
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 16 }}>
              <Text strong>{t('roninProCustomSliceExpand')}</Text>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('roninProCustomSliceExpandMode')}:</Text>
                <Button.Group size="small">
                  <Button type={expandMode === 'all' ? 'primary' : 'default'} onClick={() => setExpandMode('all')}>
                    {t('roninProCustomSliceExpandModeAll')}
                  </Button>
                  <Button type={expandMode === 'heightUpOnly' ? 'primary' : 'default'} onClick={() => setExpandMode('heightUpOnly')}>
                    {t('roninProCustomSliceExpandModeHeightUpOnly')}
                  </Button>
                </Button.Group>
              </div>
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
                <span>
                  <Text type="secondary">{t('roninProCustomSliceExpandUp')}:</Text>
                  <InputNumber
                    min={0}
                    max={128}
                    value={expandUp}
                    onChange={(v) => setExpandUp(v ?? 0)}
                    style={{ width: 56, marginLeft: 6 }}
                  />
                </span>
                <span>
                  <Text type="secondary">{t('roninProCustomSliceExpandDown')}:</Text>
                  <InputNumber
                    min={0}
                    max={128}
                    value={expandDown}
                    onChange={(v) => setExpandDown(v ?? 0)}
                    style={{ width: 56, marginLeft: 6 }}
                  />
                </span>
                <span>
                  <Text type="secondary">{t('roninProCustomSliceExpandLeft')}:</Text>
                  <InputNumber
                    min={0}
                    max={128}
                    value={expandLeft}
                    onChange={(v) => setExpandLeft(v ?? 0)}
                    style={{ width: 56, marginLeft: 6 }}
                  />
                </span>
                <span>
                  <Text type="secondary">{t('roninProCustomSliceExpandRight')}:</Text>
                  <InputNumber
                    min={0}
                    max={128}
                    value={expandRight}
                    onChange={(v) => setExpandRight(v ?? 0)}
                    style={{ width: 56, marginLeft: 6 }}
                  />
                </span>
              </div>
              <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('roninProCustomSliceExpandPreset')}:</Text>
                {[32, 48, 64, 96, 128, 144, 150].map((n) => (
                  <Button key={n} size="small" onClick={() => applyExpandPreset(n)}>
                    {n}×{n}
                  </Button>
                ))}
                <Button size="small" onClick={() => applyExpandPreset(32, 64)}>
                  32×64
                </Button>
              </div>
              <Text type="secondary" style={{ marginTop: 8, fontSize: 12, display: 'block' }}>
                {t('roninProCustomSliceExpandSizeHint', {
                  cellW: paddedCellW,
                  cellH: paddedCellH,
                  outW: composedOutW,
                  outH: composedOutH,
                })}
              </Text>
            </div>

            {composedUrl && (
              <div style={{ marginTop: 12 }}>
                <Text strong>{t('roninProCustomSliceComposedPreview')}</Text>
                <div
                  style={{
                    marginTop: 8,
                    padding: 16,
                    background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
                    borderRadius: 8,
                    border: '1px solid #9a8b78',
                    display: 'inline-block',
                  }}
                >
                  <StashableImage
                    src={composedUrl}
                    alt="composed"
                    style={{ maxWidth: 320, maxHeight: 240, display: 'block', imageRendering: 'pixelated' }}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </Space>
  )
}
