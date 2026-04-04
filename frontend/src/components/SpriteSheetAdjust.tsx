import React, { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, ColorPicker, InputNumber, message, Progress, Radio, Segmented, Slider, Space, Switch, Tooltip, Typography, Upload } from 'antd'
import JSZip from 'jszip'
import { superSplitByTransparent } from '../lib/superSplitTransparent'
import {
  applySheetProPreprocess,
  sheetProPreprocessIsNoop,
  type SheetProPreprocessOptions,
} from '../lib/sheetProPreprocess'
// @ts-expect-error gifenc has no types
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  CaretLeftOutlined,
  CaretRightOutlined,
  DeleteOutlined,
  DragOutlined,
  MinusOutlined,
  PlusOutlined,
  StepBackwardOutlined,
  StepForwardOutlined,
} from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { useLanguage } from '../i18n/context'
import StashDropZone from './StashDropZone'
import CropPreview from './CropPreview'

const { Dragger } = Upload
const { Text } = Typography

const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']
const IMAGE_MAX_MB = 20

type FrameOffset = { dx: number; dy: number }

export type FrameCrop = { top: number; bottom: number; left: number; right: number }

function emptyCrop(): FrameCrop {
  return { top: 0, bottom: 0, left: 0, right: 0 }
}

/** 与 GifFrameConverter 多图合成一致：正数裁边，负数在该侧扩透明边 */
function frameCropDrawParams(iw: number, ih: number, cr: FrameCrop) {
  const t = cr.top
  const b = cr.bottom
  const l = cr.left
  const r = cr.right
  const sw = Math.max(1, iw - l - r)
  const sh = Math.max(1, ih - t - b)
  const sx = Math.max(0, l)
  const sy = Math.max(0, t)
  const srcW = Math.max(1, iw - Math.max(0, l) - Math.max(0, r))
  const srcH = Math.max(1, ih - Math.max(0, t) - Math.max(0, b))
  const padX = Math.max(0, -l)
  const padY = Math.max(0, -t)
  return { sw, sh, sx, sy, srcW, srcH, padX, padY }
}

const ShiftedFrameCanvas = forwardRef<HTMLCanvasElement | null, {
  src: string
  dx: number
  dy: number
  displayWidth?: number
  displayHeight?: number
  onSize?: (w: number, h: number) => void
  /** 与 layoutCellW/H 同时使用时：先裁边再绘制到固定格内 */
  crop?: FrameCrop
  layoutCellW?: number
  layoutCellH?: number
  onContentSize?: (sw: number, sh: number) => void
  style?: React.CSSProperties
}>(function ShiftedFrameCanvas({
  src,
  dx,
  dy,
  displayWidth,
  displayHeight,
  onSize,
  crop: cropIn,
  layoutCellW,
  layoutCellH,
  onContentSize,
  style,
}, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const innerRef = (el: HTMLCanvasElement | null) => {
    (canvasRef as React.MutableRefObject<HTMLCanvasElement | null>).current = el
    if (typeof ref === 'function') ref(el)
    else if (ref) ref.current = el
  }

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas || !img.naturalWidth || !img.naturalHeight) return
      const iw = img.naturalWidth
      const ih = img.naturalHeight
      const cr = cropIn ?? emptyCrop()
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      if (layoutCellW != null && layoutCellH != null && layoutCellW > 0 && layoutCellH > 0) {
        const { sw, sh, sx, sy, srcW, srcH, padX, padY } = frameCropDrawParams(iw, ih, cr)
        canvas.width = layoutCellW
        canvas.height = layoutCellH
        ctx.clearRect(0, 0, layoutCellW, layoutCellH)
        ctx.drawImage(img, sx, sy, srcW, srcH, dx + padX, dy + padY, srcW, srcH)
        onSize?.(layoutCellW, layoutCellH)
        onContentSize?.(sw, sh)
      } else {
        canvas.width = iw
        canvas.height = ih
        ctx.clearRect(0, 0, iw, ih)
        ctx.drawImage(img, 0, 0, iw, ih, dx, dy, iw, ih)
        onSize?.(iw, ih)
      }
    }
    img.src = src
    return () => {
      img.src = ''
    }
  }, [src, dx, dy, onSize, onContentSize, cropIn?.top, cropIn?.bottom, cropIn?.left, cropIn?.right, layoutCellW, layoutCellH])

  return (
    <canvas
      ref={innerRef}
      style={{
        width: displayWidth ? `${displayWidth}px` : '100%',
        height: displayHeight ? `${displayHeight}px` : '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        minWidth: 0,
        minHeight: 0,
        objectFit: 'contain',
        imageRendering: 'pixelated',
        display: 'block',
        ...style,
      }}
    />
  )
})

function splitSpriteSheet(
  img: HTMLImageElement,
  cols: number,
  rows: number
): HTMLCanvasElement[] {
  const fullW = img.naturalWidth
  const fullH = img.naturalHeight
  const colsNum = Math.max(1, Math.floor(cols))
  const rowsNum = Math.max(1, Math.floor(rows))
  const results: HTMLCanvasElement[] = []

  for (let row = 0; row < rowsNum; row++) {
    for (let col = 0; col < colsNum; col++) {
      const sx = Math.floor((col * fullW) / colsNum)
      const ex = Math.floor(((col + 1) * fullW) / colsNum)
      const sy = Math.floor((row * fullH) / rowsNum)
      const ey = Math.floor(((row + 1) * fullH) / rowsNum)
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

async function recombineFrames(
  frameUrls: string[],
  frameOffsets: FrameOffset[],
  frameCrops: FrameCrop[],
  cols: number,
  rows: number
): Promise<{ url: string; cellW: number; cellH: number }> {
  if (frameUrls.length === 0) throw new Error('No frames')
  const imgs = await Promise.all(
    frameUrls.map(
      (u) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.onload = () => resolve(im)
          im.onerror = () => reject(new Error('Failed to load frame'))
          im.src = u
        }),
    ),
  )
  let cellW = 1
  let cellH = 1
  for (let i = 0; i < imgs.length; i++) {
    const cr = frameCrops[i] ?? emptyCrop()
    const im = imgs[i]!
    const sw = Math.max(1, im.naturalWidth - cr.left - cr.right)
    const sh = Math.max(1, im.naturalHeight - cr.top - cr.bottom)
    cellW = Math.max(cellW, sw)
    cellH = Math.max(cellH, sh)
  }
  const outW = cellW * cols
  const outH = cellH * rows
  const out = document.createElement('canvas')
  out.width = outW
  out.height = outH
  const ctx = out.getContext('2d')!
  for (let i = 0; i < frameUrls.length; i++) {
    const img = imgs[i]!
    const cr = frameCrops[i] ?? emptyCrop()
    const { sx, sy, srcW, srcH, padX, padY } = frameCropDrawParams(img.naturalWidth, img.naturalHeight, cr)
    const r = Math.floor(i / cols)
    const c = i % cols
    const dx = frameOffsets[i]?.dx ?? 0
    const dy = frameOffsets[i]?.dy ?? 0
    const tmp = document.createElement('canvas')
    tmp.width = cellW
    tmp.height = cellH
    const tctx = tmp.getContext('2d')!
    tctx.clearRect(0, 0, cellW, cellH)
    tctx.drawImage(img, sx, sy, srcW, srcH, dx + padX, dy + padY, srcW, srcH)
    ctx.drawImage(tmp, 0, 0, cellW, cellH, c * cellW, r * cellH, cellW, cellH)
  }
  return new Promise<{ url: string; cellW: number; cellH: number }>((resolve, reject) => {
    out.toBlob((b) => {
      if (b) resolve({ url: URL.createObjectURL(b), cellW, cellH })
      else reject(new Error('toBlob failed'))
    }, 'image/png')
  })
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('load'))
    img.src = src
  })
}

/** RoninPro：单图网格拆分与整图均分功能重叠且易混淆；暂隐藏第三项，改为 true 恢复 */
const SHEET_PRO_GRID_SPLIT_VISIBLE = false

export interface SpriteSheetAdjustProps {
  /**
   * RoninPro「单图调整 Pro」：整图均分 / 透明拆分（单图网格拆分见 SHEET_PRO_GRID_SPLIT_VISIBLE）→ 格内偏移与边缘裁剪、合成分辨率
   */
  integratedSplit?: boolean
}

export default function SpriteSheetAdjust({ integratedSplit = false }: SpriteSheetAdjustProps = {}) {
  const { t } = useLanguage()
  const [file, setFile] = useState<File | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [cols, setCols] = useState(8)
  const [rows, setRows] = useState(4)
  /** Pro：整图均分时的切分列 N / 行 M（如何从原图切块） */
  const [splitCols, setSplitCols] = useState(8)
  const [splitRows, setSplitRows] = useState(4)
  /** Pro：分割预览排列与合成时的列数（每行几帧）及行数 */
  const [layoutCols, setLayoutCols] = useState(8)
  const [layoutRows, setLayoutRows] = useState(4)
  const [frameUrls, setFrameUrls] = useState<string[]>([])
  const [selected, setSelected] = useState<boolean[]>([])
  const frameDelay = 100
  const [playing, setPlaying] = useState(false)
  const [currentIdx, setCurrentIdx] = useState(0)
  const [speedScale, setSpeedScale] = useState(1)
  const [previewZoom, setPreviewZoom] = useState(4)
  const [previewImgSize, setPreviewImgSize] = useState<{ w: number; h: number } | null>(null)
  const [previewBg, setPreviewBg] = useState<'checkered' | string>('#e4dbcf')
  const [previewBgColor, setPreviewBgColor] = useState('#e4dbcf')
  const [frameOffsets, setFrameOffsets] = useState<FrameOffset[]>([])
  const [fixedPixelMode, setFixedPixelMode] = useState(false)
  const [fixedPixelRange, setFixedPixelRange] = useState(1)
  type FixedPixelFix = { imgX: number; imgY: number; range: number; data: Uint8ClampedArray }
  const [fixedPixelFixes, setFixedPixelFixes] = useState<FixedPixelFix[]>([])
  const [mouseInPreview, setMouseInPreview] = useState(false)
  const [previewMousePos, setPreviewMousePos] = useState<{ x: number; y: number } | null>(null)
  const [gifExporting, setGifExporting] = useState(false)
  const [sheetInputMode, setSheetInputMode] = useState<'whole' | 'grid' | 'transparent'>('whole')
  const [splitRowsIn, setSplitRowsIn] = useState(2)
  const [splitColsIn, setSplitColsIn] = useState(2)
  const [splitLoading, setSplitLoading] = useState(false)
  const [transparentLayoutCols, setTransparentLayoutCols] = useState(4)
  const [sheetPreEnabled, setSheetPreEnabled] = useState(false)
  const [sheetPreWatermark, setSheetPreWatermark] = useState(false)
  const [sheetPreResizeOn, setSheetPreResizeOn] = useState(false)
  const [sheetPreResizeW, setSheetPreResizeW] = useState(256)
  const [sheetPreResizeH, setSheetPreResizeH] = useState(256)
  const [sheetPreResizeKeepAspect, setSheetPreResizeKeepAspect] = useState(false)
  const [sheetPreMatteMode, setSheetPreMatteMode] = useState<'none' | 'contiguous' | 'global'>('none')
  const [sheetPreTol, setSheetPreTol] = useState(80)
  const [sheetPreFeather, setSheetPreFeather] = useState(5)
  const [sheetPreCropT, setSheetPreCropT] = useState(0)
  const [sheetPreCropB, setSheetPreCropB] = useState(0)
  const [sheetPreCropL, setSheetPreCropL] = useState(0)
  const [sheetPreCropR, setSheetPreCropR] = useState(0)
  const [sheetPrePadT, setSheetPrePadT] = useState(0)
  const [sheetPrePadR, setSheetPrePadR] = useState(0)
  const [sheetPrePadB, setSheetPrePadB] = useState(0)
  const [sheetPrePadL, setSheetPrePadL] = useState(0)
  const [sheetPreUrl, setSheetPreUrl] = useState<string | null>(null)
  const [sheetPreBusy, setSheetPreBusy] = useState(false)
  /** Pro 导入预览图（原图或预处理后）的像素尺寸 */
  const [importPreviewDims, setImportPreviewDims] = useState<{ w: number; h: number } | null>(null)
  const [frameCrops, setFrameCrops] = useState<FrameCrop[]>([])
  /** RoninPro：四边数值应用到每一帧（与 GIF 多图合成裁边语义一致，含负数扩边） */
  const [integratedEdgeCrop, setIntegratedEdgeCrop] = useState<FrameCrop>(() => emptyCrop())
  /** Pro 裁边预览：切换参考帧（裁边数值仍应用到全部帧） */
  const [proCropPreviewIdx, setProCropPreviewIdx] = useState(0)
  /** Pro 分割预览：拖拽重排帧顺序 */
  const [integratedPreviewDragIdx, setIntegratedPreviewDragIdx] = useState<number | null>(null)
  const [naturalSizes, setNaturalSizes] = useState<{ w: number; h: number }[]>([])
  const [previewContentSize, setPreviewContentSize] = useState<{ w: number; h: number } | null>(null)
  /** 与当前 frameUrls 同批写入：跳过对每帧 blob 再解码一遍取宽高 */
  const pendingIntrinsicSizesRef = useRef<{ w: number; h: number }[] | null>(null)
  /** Pro 整图均分：仅在「源图/模式」未变时跳过因改列/行触发的整图重切 */
  const lastIntegratedWholeSplitKeyRef = useRef<string>('')
  /** 仅 revoke 已从 frameUrls 移除的 object URL，避免删帧/重排时误撤销仍在使用的 URL */
  const prevFrameObjectUrlsRef = useRef<string[]>([])
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const previewContainerRef = useRef<HTMLDivElement | null>(null)

  type PressCountKey = 'up' | 'down' | 'left' | 'right'
  const [framePressCounts, setFramePressCounts] = useState<Record<PressCountKey, number>[]>([])
  const [recombinedUrl, setRecombinedUrl] = useState<string | null>(null)
  const [recombinedParams, setRecombinedParams] = useState<{ cellW: number; cellH: number } | null>(null)
  const [recombining, setRecombining] = useState(false)
  const [applyProgress, setApplyProgress] = useState<number | null>(null)

  const gridCols = integratedSplit ? layoutCols : cols
  const gridRows = integratedSplit ? layoutRows : rows

  const setFrameOffsetAndCount = useCallback((idx: number, delta: Partial<FrameOffset>, countKey: PressCountKey) => {
    setFrameOffsets((prev) => {
      const next = [...prev]
      if (!next[idx]) next[idx] = { dx: 0, dy: 0 }
      next[idx] = {
        dx: (next[idx]!.dx ?? 0) + (delta.dx ?? 0),
        dy: (next[idx]!.dy ?? 0) + (delta.dy ?? 0),
      }
      return next
    })
    setFramePressCounts((prev) => {
      const next = [...prev]
      if (!next[idx]) next[idx] = { up: 0, down: 0, left: 0, right: 0 }
      next[idx] = { ...next[idx]!, [countKey]: (next[idx]![countKey] ?? 0) + 1 }
      return next
    })
  }, [])

  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file)
      setOriginalUrl(url)
      if (integratedSplit) {
        setSheetInputMode('whole')
        setIntegratedEdgeCrop(emptyCrop())
        setSplitCols(8)
        setSplitRows(4)
        setLayoutCols(8)
        setLayoutRows(4)
      }
      lastIntegratedWholeSplitKeyRef.current = ''
      return () => URL.revokeObjectURL(url)
    }
    setOriginalUrl(null)
    setFrameUrls([])
    setSelected([])
    lastIntegratedWholeSplitKeyRef.current = ''
  }, [file, integratedSplit])

  useEffect(() => {
    if (integratedSplit && !SHEET_PRO_GRID_SPLIT_VISIBLE && sheetInputMode === 'grid') {
      setSheetInputMode('whole')
    }
  }, [integratedSplit, sheetInputMode])

  const sheetPreOpts = useMemo(
    (): SheetProPreprocessOptions => ({
      watermark: sheetPreWatermark,
      cropTop: sheetPreCropT,
      cropBottom: sheetPreCropB,
      cropLeft: sheetPreCropL,
      cropRight: sheetPreCropR,
      padTop: sheetPrePadT,
      padRight: sheetPrePadR,
      padBottom: sheetPrePadB,
      padLeft: sheetPrePadL,
      resizeEnabled: sheetPreResizeOn,
      resizeW: sheetPreResizeW,
      resizeH: sheetPreResizeH,
      resizeKeepAspect: sheetPreResizeKeepAspect,
      matteMode: sheetPreMatteMode,
      matteTolerance: sheetPreTol,
      matteFeather: sheetPreFeather,
    }),
    [
      sheetPreWatermark,
      sheetPreCropT,
      sheetPreCropB,
      sheetPreCropL,
      sheetPreCropR,
      sheetPrePadT,
      sheetPrePadR,
      sheetPrePadB,
      sheetPrePadL,
      sheetPreResizeOn,
      sheetPreResizeW,
      sheetPreResizeH,
      sheetPreResizeKeepAspect,
      sheetPreMatteMode,
      sheetPreTol,
      sheetPreFeather,
    ],
  )

  const splitSourceUrl = useMemo(() => {
    if (!integratedSplit || !sheetPreEnabled) return originalUrl
    if (sheetProPreprocessIsNoop(sheetPreOpts)) return originalUrl
    if (sheetPreBusy || !sheetPreUrl) return null
    return sheetPreUrl
  }, [integratedSplit, sheetPreEnabled, sheetPreOpts, sheetPreBusy, sheetPreUrl, originalUrl])

  useEffect(() => {
    if (!integratedSplit || !file || !originalUrl) {
      setImportPreviewDims(null)
      return
    }
    const url = splitSourceUrl ?? originalUrl
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) setImportPreviewDims({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      if (!cancelled) setImportPreviewDims(null)
    }
    img.src = url
    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
      img.src = ''
    }
  }, [integratedSplit, file, originalUrl, splitSourceUrl])

  useEffect(() => {
    if (!integratedSplit || !sheetPreEnabled || !file) {
      setSheetPreUrl((u) => {
        if (u) URL.revokeObjectURL(u)
        return null
      })
      setSheetPreBusy(false)
      return
    }
    if (sheetProPreprocessIsNoop(sheetPreOpts)) {
      setSheetPreUrl((u) => {
        if (u) URL.revokeObjectURL(u)
        return null
      })
      setSheetPreBusy(false)
      return
    }
    let cancelled = false
    setSheetPreBusy(true)
    ;(async () => {
      try {
        const out = await applySheetProPreprocess(file, sheetPreOpts)
        const url = URL.createObjectURL(out)
        if (!cancelled) {
          setSheetPreUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return url
          })
        } else {
          URL.revokeObjectURL(url)
        }
      } catch (e) {
        if (!cancelled) {
          message.error(t('sheetPreFailed') + ': ' + String(e))
          setSheetPreUrl((prev) => {
            if (prev) URL.revokeObjectURL(prev)
            return null
          })
        }
      } finally {
        if (!cancelled) setSheetPreBusy(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [integratedSplit, sheetPreEnabled, file, sheetPreOpts, t])

  useEffect(() => {
    const prev = prevFrameObjectUrlsRef.current
    for (const u of prev) {
      if (!frameUrls.includes(u)) URL.revokeObjectURL(u)
    }
    prevFrameObjectUrlsRef.current = frameUrls.slice()
  }, [frameUrls])

  useEffect(() => {
    return () => {
      prevFrameObjectUrlsRef.current.forEach(URL.revokeObjectURL)
    }
  }, [])

  useEffect(() => {
    setFrameCrops((prev) => {
      const n = frameUrls.length
      if (prev.length === n) return prev
      return frameUrls.map(() => emptyCrop())
    })
    setProCropPreviewIdx((i) => {
      const n = frameUrls.length
      if (n === 0) return 0
      return Math.min(i, n - 1)
    })
  }, [frameUrls])

  const effectiveFrameCrops = useMemo(() => {
    if (!integratedSplit) return frameCrops
    return frameUrls.map(() => integratedEdgeCrop)
  }, [integratedSplit, frameUrls, integratedEdgeCrop, frameCrops])

  useEffect(() => {
    let cancelled = false
    if (frameUrls.length === 0) {
      pendingIntrinsicSizesRef.current = null
      setNaturalSizes([])
      return
    }
    const pending = pendingIntrinsicSizesRef.current
    if (pending && pending.length === frameUrls.length) {
      pendingIntrinsicSizesRef.current = null
      setNaturalSizes(pending)
      return
    }
    Promise.all(
      frameUrls.map(
        (u) =>
          new Promise<{ w: number; h: number }>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve({ w: im.naturalWidth, h: im.naturalHeight })
            im.onerror = () => reject(new Error('load'))
            im.src = u
          }),
      ),
    )
      .then((sizes) => {
        if (!cancelled) setNaturalSizes(sizes)
      })
      .catch(() => {
        if (!cancelled) setNaturalSizes([])
      })
    return () => {
      cancelled = true
    }
  }, [frameUrls])

  const { cellW, cellH, composedW, composedH } = useMemo(() => {
    if (frameUrls.length === 0 || naturalSizes.length !== frameUrls.length) {
      return { cellW: 0, cellH: 0, composedW: 0, composedH: 0 }
    }
    let maxCw = 1
    let maxCh = 1
    for (let i = 0; i < naturalSizes.length; i++) {
      const cr = effectiveFrameCrops[i] ?? emptyCrop()
      const nw = naturalSizes[i]!.w
      const nh = naturalSizes[i]!.h
      const sw = Math.max(1, nw - cr.left - cr.right)
      const sh = Math.max(1, nh - cr.top - cr.bottom)
      maxCw = Math.max(maxCw, sw)
      maxCh = Math.max(maxCh, sh)
    }
    return {
      cellW: maxCw,
      cellH: maxCh,
      composedW: maxCw * gridCols,
      composedH: maxCh * gridRows,
    }
  }, [naturalSizes, effectiveFrameCrops, frameUrls.length, gridCols, gridRows])

  const layoutReady = cellW > 0 && cellH > 0 && naturalSizes.length === frameUrls.length && frameUrls.length > 0

  const anyFrameCrop = useMemo(
    () =>
      effectiveFrameCrops.some(
        (c) =>
          (c?.top ?? 0) !== 0 ||
          (c?.bottom ?? 0) !== 0 ||
          (c?.left ?? 0) !== 0 ||
          (c?.right ?? 0) !== 0,
      ),
    [effectiveFrameCrops],
  )
  /** 仅 RoninPro 且在调整裁边时启用「固定单格」canvas；否则缩略图走旧版轻量路径，避免卡顿 */
  const useIntegratedLayoutCanvas = layoutReady && integratedSplit && anyFrameCrop

  const applySplitFromGrid = useCallback(async () => {
    const src = splitSourceUrl
    if (!src || !file) return
    setSplitLoading(true)
    try {
      const img = await loadImageElement(src)
      const w = img.naturalWidth
      const h = img.naturalHeight
      const rowsN = Math.max(1, Math.floor(splitRowsIn))
      const colsN = Math.max(1, Math.floor(splitColsIn))
      const cellWi = Math.floor(w / colsN)
      const cellHi = Math.floor(h / rowsN)
      if (cellWi <= 0 || cellHi <= 0) throw new Error('split')
      /** 每格独立小画布 + 分批并行 toBlob，避免原先逐格 await 导致 N 倍串行延迟 */
      const GRID_TOBLOB_BATCH = 32
      const cells: { r: number; c: number }[] = []
      for (let r = 0; r < rowsN; r++) {
        for (let c = 0; c < colsN; c++) cells.push({ r, c })
      }
      const urls: string[] = []
      for (let i = 0; i < cells.length; i += GRID_TOBLOB_BATCH) {
        const slice = cells.slice(i, i + GRID_TOBLOB_BATCH)
        const part = await Promise.all(
          slice.map(
            ({ r, c }) =>
              new Promise<string>((resolve, reject) => {
                const cnv = document.createElement('canvas')
                cnv.width = cellWi
                cnv.height = cellHi
                const cctx = cnv.getContext('2d')!
                cctx.drawImage(img, c * cellWi, r * cellHi, cellWi, cellHi, 0, 0, cellWi, cellHi)
                cnv.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('canvas'))), 'image/png')
              }),
          ),
        )
        urls.push(...part)
      }
      pendingIntrinsicSizesRef.current = urls.map(() => ({ w: cellWi, h: cellHi }))
      if (integratedSplit) {
        setSplitCols(colsN)
        setSplitRows(rowsN)
        setLayoutCols(colsN)
        setLayoutRows(rowsN)
      } else {
        setCols(colsN)
        setRows(rowsN)
      }
      setPreviewImgSize(null)
      setPreviewContentSize(null)
      setFrameOffsets([])
      setFramePressCounts([])
      setRecombinedUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
      setRecombinedParams(null)
      setFixedPixelMode(false)
      setFixedPixelFixes([])
      lastIntegratedWholeSplitKeyRef.current = ''
      setFrameUrls(urls)
      setSelected(urls.map((_, i) => i < Math.min(6, urls.length)))
      setCurrentIdx(0)
      message.success(t('imagesToSingleSplitSuccess', { n: urls.length }))
    } catch (e) {
      message.error(t('imagesToSingleSplitFailed') + ': ' + String(e))
    } finally {
      setSplitLoading(false)
    }
  }, [splitSourceUrl, file, splitRowsIn, splitColsIn, t, integratedSplit])

  const applySplitTransparent = useCallback(async () => {
    const src = splitSourceUrl
    if (!src || !file) {
      if (integratedSplit && sheetPreEnabled && !sheetProPreprocessIsNoop(sheetPreOpts) && (sheetPreBusy || !sheetPreUrl)) {
        message.warning(t('sheetPreWait'))
      }
      return
    }
    setSplitLoading(true)
    try {
      const img = await loadImageElement(src)
      const baseName = file.name.replace(/\.[^.]+$/, '')
      const files = await superSplitByTransparent(img, baseName)
      const urls = files.map((f) => URL.createObjectURL(f))
      if (files.length > 0) {
        const probe = URL.createObjectURL(files[0]!)
        try {
          const dim = await loadImageElement(probe)
          const cw = dim.naturalWidth
          const ch = dim.naturalHeight
          pendingIntrinsicSizesRef.current = files.map(() => ({ w: cw, h: ch }))
        } finally {
          URL.revokeObjectURL(probe)
        }
      }
      const n = urls.length
      const colsN = Math.max(1, Math.floor(transparentLayoutCols) || Math.ceil(Math.sqrt(n)))
      const rowsN = Math.max(1, Math.ceil(n / colsN))
      if (integratedSplit) {
        setLayoutCols(colsN)
        setLayoutRows(rowsN)
        setSplitCols(colsN)
        setSplitRows(rowsN)
      } else {
        setCols(colsN)
        setRows(rowsN)
      }
      setPreviewImgSize(null)
      setPreviewContentSize(null)
      setFrameOffsets([])
      setFramePressCounts([])
      setRecombinedUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
      setRecombinedParams(null)
      setFixedPixelMode(false)
      setFixedPixelFixes([])
      lastIntegratedWholeSplitKeyRef.current = ''
      setFrameUrls(urls)
      setSelected(urls.map((_, i) => i < Math.min(6, urls.length)))
      setCurrentIdx(0)
      message.success(t('imagesToSingleSuperSplitSuccess', { n: urls.length }))
    } catch (e) {
      message.error(t('imagesToSingleSuperSplitFailed') + ': ' + String(e))
    } finally {
      setSplitLoading(false)
    }
  }, [
    splitSourceUrl,
    file,
    transparentLayoutCols,
    t,
    integratedSplit,
    sheetPreEnabled,
    sheetPreOpts,
    sheetPreBusy,
    sheetPreUrl,
  ])

  const downloadFramesZip = useCallback(async () => {
    if (frameUrls.length === 0) return
    try {
      const zip = new JSZip()
      const base = file?.name.replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '_') || 'frames'
      for (let i = 0; i < frameUrls.length; i++) {
        const blob = await fetch(frameUrls[i]!).then((r) => r.blob())
        zip.file(`frame_${String(i).padStart(3, '0')}.png`, blob)
      }
      const zblob = await zip.generateAsync({ type: 'blob' })
      const href = URL.createObjectURL(zblob)
      const a = document.createElement('a')
      a.href = href
      a.download = `${base}_frames.zip`
      a.click()
      URL.revokeObjectURL(href)
      message.success(t('roninProSheetProZipSuccess'))
    } catch (e) {
      message.error(String(e))
    }
  }, [frameUrls, file?.name, t])

  useEffect(() => {
    if (!file) return
    if (integratedSplit && sheetInputMode !== 'whole') return
    if (integratedSplit && sheetPreEnabled && !sheetProPreprocessIsNoop(sheetPreOpts) && !splitSourceUrl) {
      setFrameUrls([])
      setSelected([])
      return
    }
    if (!splitSourceUrl) return

    const splitGc = integratedSplit ? splitCols : cols
    const splitGr = integratedSplit ? splitRows : rows
    const integratedWholeKey =
      integratedSplit && sheetInputMode === 'whole'
        ? `${splitSourceUrl}|${splitCols}|${splitRows}`
        : ''
    if (
      integratedSplit &&
      sheetInputMode === 'whole' &&
      frameUrls.length > 0 &&
      integratedWholeKey === lastIntegratedWholeSplitKeyRef.current
    ) {
      return
    }

    const img = new Image()
    img.onload = async () => {
      const canvases = splitSpriteSheet(img, splitGc, splitGr)
      const urls = canvases.map((c) => {
        return new Promise<string>((resolve, reject) => {
          c.toBlob((b) => {
            if (b) resolve(URL.createObjectURL(b))
            else reject(new Error('blob'))
          }, 'image/png')
        })
      })
      const resolved = await Promise.all(urls)
      pendingIntrinsicSizesRef.current = canvases.map((c) => ({ w: c.width, h: c.height }))
      setPreviewImgSize(null)
      setFrameOffsets([])
      setFramePressCounts([])
      setRecombinedUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return null
      })
      setRecombinedParams(null)
      setFixedPixelMode(false)
      setFixedPixelFixes([])
      setFrameUrls(resolved)
      setSelected(resolved.map((_, i) => i < 6))
      setCurrentIdx(0)
      if (integratedSplit && sheetInputMode === 'whole') {
        lastIntegratedWholeSplitKeyRef.current = integratedWholeKey
        setLayoutCols(splitCols)
        setLayoutRows(splitRows)
      }
    }
    img.src = splitSourceUrl
  }, [
    splitSourceUrl,
    file,
    cols,
    rows,
    splitCols,
    splitRows,
    integratedSplit,
    sheetInputMode,
    sheetPreEnabled,
    sheetPreOpts,
    frameUrls.length,
  ])

  useEffect(() => {
    if (!(integratedSplit && frameUrls.length > 0)) return
    const n = frameUrls.length
    const nextRows = Math.max(1, Math.ceil(n / Math.max(1, layoutCols)))
    setLayoutRows((r) => (r === nextRows ? r : nextRows))
  }, [integratedSplit, frameUrls.length, layoutCols])

  const handleRecombine = async () => {
    if (frameUrls.length === 0) return
    setRecombining(true)
    setRecombinedUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    setRecombinedParams(null)
    try {
      const { url, cellW, cellH } = await recombineFrames(
        frameUrls,
        frameOffsets,
        effectiveFrameCrops,
        gridCols,
        gridRows,
      )
      setRecombinedUrl(url)
      setRecombinedParams({ cellW, cellH })
    } finally {
      setRecombining(false)
    }
  }

  const applyFixedPixels = async () => {
    if (integratedSplit) return
    if (fixedPixelFixes.length === 0 || selectedIndices.length === 0) return
    const frameW = previewImgSize?.w ?? 0
    const frameH = previewImgSize?.h ?? 0
    if (frameW <= 0 || frameH <= 0) return
    setApplyProgress(0)
    const newUrls: string[] = []
    const total = frameUrls.length
    try {
    for (let i = 0; i < total; i++) {
      if (!selected[i]) {
        const resp = await fetch(frameUrls[i]!)
        const blob = await resp.blob()
        newUrls.push(URL.createObjectURL(blob))
      } else {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const im = new Image()
          im.onload = () => resolve(im)
          im.onerror = () => reject(new Error('Failed to load frame'))
          im.src = frameUrls[i]!
        })
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        if (fixedPixelFixes.length > 0) {
          const fullData = ctx.getImageData(0, 0, frameW, frameH)
          const mask = new Uint8Array(frameW * frameH)
          for (let fi = fixedPixelFixes.length - 1; fi >= 0; fi--) {
            const fix = fixedPixelFixes[fi]!
            const d = fix.data
            for (let oy = 0; oy < fix.range; oy++) {
              for (let ox = 0; ox < fix.range; ox++) {
                const px = fix.imgX + ox
                const py = fix.imgY + oy
                if (mask[py * frameW + px]) continue
                mask[py * frameW + px] = 1
                const src = (oy * fix.range + ox) * 4
                const dst = (py * frameW + px) * 4
                fullData.data[dst] = d[src]!
                fullData.data[dst + 1] = d[src + 1]!
                fullData.data[dst + 2] = d[src + 2]!
                fullData.data[dst + 3] = d[src + 3]!
              }
            }
          }
          ctx.putImageData(fullData, 0, 0)
        }
        const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'))
        if (blob) newUrls.push(URL.createObjectURL(blob))
        else newUrls.push(frameUrls[i]!)
      }
      setApplyProgress(Math.round(((i + 1) / total) * 100))
    }
    setFrameUrls(newUrls)
    setFixedPixelFixes([])
    setFixedPixelMode(false)
    } finally {
      setApplyProgress(null)
    }
  }

  const cancelFixedPixels = () => {
    setFixedPixelFixes([])
    setFixedPixelMode(false)
  }

  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (integratedSplit) return
    if (!fixedPixelMode || !previewCanvasRef.current || !previewImgSize || !displayUrl) return
    const canvas = previewCanvasRef.current
    const rect = canvas.getBoundingClientRect()
    const dx = frameOffsets[displayIdx]?.dx ?? 0
    const dy = frameOffsets[displayIdx]?.dy ?? 0
    const relX = (e.clientX - rect.left) / rect.width
    const relY = (e.clientY - rect.top) / rect.height
    const canvasX = Math.floor(relX * canvas.width)
    const canvasY = Math.floor(relY * canvas.height)
    const centerImgX = canvasX - dx
    const centerImgY = canvasY - dy
    const imgX = Math.max(0, Math.min(previewImgSize.w - fixedPixelRange, centerImgX - Math.floor(fixedPixelRange / 2)))
    const imgY = Math.max(0, Math.min(previewImgSize.h - fixedPixelRange, centerImgY - Math.floor(fixedPixelRange / 2)))
    const w = previewImgSize.w
    const h = previewImgSize.h
    if (imgX < 0 || imgY < 0 || imgX + fixedPixelRange > w || imgY + fixedPixelRange > h) return
    const srcX = dx + imgX
    const srcY = dy + imgY
    if (srcX < 0 || srcY < 0 || srcX + fixedPixelRange > canvas.width || srcY + fixedPixelRange > canvas.height) return
    try {
      const imgData = canvas.getContext('2d')!.getImageData(srcX, srcY, fixedPixelRange, fixedPixelRange)
      setFixedPixelFixes((prev) => [...prev, { imgX, imgY, range: fixedPixelRange, data: new Uint8ClampedArray(imgData.data) }])
    } catch (_) {}
  }

  const selectedIndices = frameUrls.map((_, i) => i).filter((i) => selected[i])
  const displayIdx = selectedIndices.length > 0 ? selectedIndices[currentIdx % selectedIndices.length] ?? 0 : 0
  const displayUrl = frameUrls[displayIdx]
  const proCropRefIdx = frameUrls.length > 0 ? Math.min(proCropPreviewIdx, frameUrls.length - 1) : 0
  const proCropRefUrl = frameUrls[proCropRefIdx]
  const proCropRefSize = naturalSizes[proCropRefIdx]
  const speed = Math.max(50, frameDelay / speedScale)

  const handleExportGif = useCallback(async () => {
    const indices = frameUrls.map((_, i) => i).filter((i) => selected[i])
    if (indices.length === 0) {
      message.warning(t('spriteAdjustExportGifNoFrames'))
      return
    }
    setGifExporting(true)
    try {
      const delayMs = Math.round(Math.max(50, frameDelay / speedScale))
      const frameImgs: ImageData[] = []
      for (const idx of indices) {
        const img = await loadImageElement(frameUrls[idx]!)
        const cr = effectiveFrameCrops[idx] ?? emptyCrop()
        const sw = Math.max(1, img.naturalWidth - cr.left - cr.right)
        const sh = Math.max(1, img.naturalHeight - cr.top - cr.bottom)
        const dx = frameOffsets[idx]?.dx ?? 0
        const dy = frameOffsets[idx]?.dy ?? 0
        const cw = layoutReady ? cellW : sw
        const ch = layoutReady ? cellH : sh
        const c = document.createElement('canvas')
        c.width = cw
        c.height = ch
        const ctx = c.getContext('2d')!
        ctx.clearRect(0, 0, cw, ch)
        const { sx, sy, srcW, srcH, padX, padY } = frameCropDrawParams(img.naturalWidth, img.naturalHeight, cr)
        ctx.drawImage(img, sx, sy, srcW, srcH, dx + padX, dy + padY, srcW, srcH)
        frameImgs.push(ctx.getImageData(0, 0, cw, ch))
      }

      const maxW = Math.max(...frameImgs.map((m) => m.width))
      const maxH = Math.max(...frameImgs.map((m) => m.height))
      const normalizeToMax = (im: ImageData): ImageData => {
        if (im.width === maxW && im.height === maxH) return im
        const out = new ImageData(maxW, maxH)
        out.data.fill(0)
        for (let y = 0; y < im.height; y++) {
          for (let x = 0; x < im.width; x++) {
            const src = (y * im.width + x) * 4
            const dst = (y * maxW + x) * 4
            out.data[dst] = im.data[src]!
            out.data[dst + 1] = im.data[src + 1]!
            out.data[dst + 2] = im.data[src + 2]!
            out.data[dst + 3] = im.data[src + 3]!
          }
        }
        return out
      }

      const gif = GIFEncoder()
      for (let i = 0; i < frameImgs.length; i++) {
        const { data } = normalizeToMax(frameImgs[i]!)
        const palette = quantize(data, 255, {
          format: 'rgba4444',
          oneBitAlpha: 128,
          clearAlpha: true,
          clearAlphaThreshold: 128,
        })
        const index = applyPalette(data, palette, 'rgba4444')
        const transIdx = palette.findIndex((c: number[]) => c[3] === 0)
        let finalPalette: number[][]
        let finalIndex: Uint8Array
        let transparentIndex: number
        if (transIdx >= 0) {
          finalPalette = [...palette]
          finalIndex = index
          transparentIndex = transIdx
        } else {
          finalPalette = [[0, 0, 0, 0], ...palette]
          finalIndex = new Uint8Array(index.length)
          for (let j = 0; j < data.length; j += 4) {
            if (data[j + 3]! < 128) {
              finalIndex[j / 4] = 0
            } else {
              finalIndex[j / 4] = index[j / 4]! + 1
            }
          }
          transparentIndex = 0
        }
        gif.writeFrame(finalIndex, maxW, maxH, {
          palette: finalPalette,
          delay: delayMs,
          transparent: true,
          transparentIndex,
        })
      }
      gif.finish()
      const blob = new Blob([gif.bytes()], { type: 'image/gif' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const base = file?.name?.replace(/\.[^.]+$/, '') ?? 'sprite_adjust'
      a.download = `${base}_frames.gif`
      a.click()
      URL.revokeObjectURL(url)
      message.success(t('gifEncodeSuccess'))
    } catch (e) {
      message.error(t('gifEncodeFailed') + ': ' + String(e))
    } finally {
      setGifExporting(false)
    }
  }, [
    frameUrls,
    selected,
    frameOffsets,
    effectiveFrameCrops,
    frameDelay,
    speedScale,
    file?.name,
    layoutReady,
    cellW,
    cellH,
    t,
  ])

  /** 避免勾选变化后 displayIdx 未变导致键盘回调闭包过期 */
  const selMin = selectedIndices.length > 0 ? Math.min(...selectedIndices) : 0
  const selMax = selectedIndices.length > 0 ? Math.max(...selectedIndices) : 0
  const animKbdRef = useRef({ displayIdx: 0, selectedLen: 0, selMin: 0, selMax: 0 })
  animKbdRef.current = { displayIdx, selectedLen: selectedIndices.length, selMin, selMax }

  useEffect(() => {
    if (!playing || selectedIndices.length === 0) return
    const id = setInterval(() => {
      setCurrentIdx((i) => (i + 1) % selectedIndices.length)
    }, speed)
    return () => clearInterval(id)
  }, [playing, selectedIndices.length, speed])

  useEffect(() => {
    /** Q/E 扩选：按行优先（左→右、上→下）连续编号，行尾下一格为下一行第一格 */
    const totalCells = frameUrls.length
    const neighborLeftRowMajor = (idx: number): number | null => {
      if (idx <= 0) return null
      return idx - 1
    }
    const neighborRightRowMajor = (idx: number): number | null => {
      if (idx >= totalCells - 1) return null
      return idx + 1
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = document.activeElement?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if ((document.activeElement as HTMLElement | null)?.isContentEditable) return
      if (frameUrls.length === 0) return

      const { displayIdx: dIdx, selectedLen, selMin: rangeMin, selMax: rangeMax } = animKbdRef.current

      // Q/E：按「已激活范围」扩张到行优先顺序上的外侧一格（含跨行：行末 → 下一行首）
      if (e.code === 'KeyQ') {
        if (selectedLen === 0) return
        if (e.shiftKey) {
          e.preventDefault()
          setSelected((prev) => {
            const next = [...prev]
            next[rangeMin] = false
            return next
          })
          return
        }
        const n = neighborLeftRowMajor(rangeMin)
        if (n == null) return
        e.preventDefault()
        setSelected((prev) => {
          const next = [...prev]
          next[n] = true
          return next
        })
        return
      }
      if (e.code === 'KeyE') {
        if (selectedLen === 0) return
        if (e.shiftKey) {
          e.preventDefault()
          setSelected((prev) => {
            const next = [...prev]
            next[rangeMax] = false
            return next
          })
          return
        }
        const n = neighborRightRowMajor(rangeMax)
        if (n == null) return
        e.preventDefault()
        setSelected((prev) => {
          const next = [...prev]
          next[n] = true
          return next
        })
        return
      }

      if (selectedLen === 0) return

      if (e.code === 'KeyA') {
        e.preventDefault()
        setCurrentIdx((i) => (i - 1 + selectedLen) % selectedLen)
        return
      }
      if (e.code === 'KeyD') {
        e.preventDefault()
        setCurrentIdx((i) => (i + 1) % selectedLen)
        return
      }
      // 与动态帧预览旁的上下左右位移按钮一致（微调当前预览帧在格内偏移）
      if (e.code === 'ArrowUp') {
        e.preventDefault()
        setFrameOffsetAndCount(dIdx, { dy: -1 }, 'up')
        return
      }
      if (e.code === 'ArrowDown') {
        e.preventDefault()
        setFrameOffsetAndCount(dIdx, { dy: 1 }, 'down')
        return
      }
      if (e.code === 'ArrowLeft') {
        e.preventDefault()
        setFrameOffsetAndCount(dIdx, { dx: -1 }, 'left')
        return
      }
      if (e.code === 'ArrowRight') {
        e.preventDefault()
        setFrameOffsetAndCount(dIdx, { dx: 1 }, 'right')
        return
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [setFrameOffsetAndCount, frameUrls.length])

  const toggleSelect = (idx: number) => {
    setSelected((prev) => {
      const next = [...prev]
      next[idx] = !next[idx]
      return next
    })
  }

  const isRowAllSelected = (r: number) => {
    for (let c = 0; c < gridCols; c++) {
      if (!selected[r * gridCols + c]) return false
    }
    return true
  }
  const isColAllSelected = (c: number) => {
    for (let r = 0; r < gridRows; r++) {
      if (!selected[r * gridCols + c]) return false
    }
    return true
  }

  const toggleRow = (rowIdx: number) => {
    const r = Math.max(0, Math.min(rowIdx, gridRows - 1))
    const allSel = isRowAllSelected(r)
    setSelected((prev) => {
      const next = [...prev]
      for (let c = 0; c < gridCols; c++) next[r * gridCols + c] = !allSel
      return next
    })
  }

  const shiftBtnStyle: React.CSSProperties = {
    padding: 2,
    minWidth: 20,
    border: '1px solid #9a8b78',
    borderRadius: 2,
    background: '#e4dbcf',
    color: '#3d3428',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11,
  }

  const toggleCol = (colIdx: number) => {
    const c = Math.max(0, Math.min(colIdx, gridCols - 1))
    const allSel = isColAllSelected(c)
    setSelected((prev) => {
      const next = [...prev]
      for (let r = 0; r < gridRows; r++) next[r * gridCols + c] = !allSel
      return next
    })
  }

  const mapReorderLocalIndex = useCallback((idx: number, from: number, to: number) => {
    if (idx === from) return to
    if (from < to) {
      if (idx > from && idx <= to) return idx - 1
    } else if (from > to) {
      if (idx >= to && idx < from) return idx + 1
    }
    return idx
  }, [])

  const reorderIntegratedPreviewFrames = useCallback(
    (from: number, to: number) => {
      if (!integratedSplit || from === to) return
      setIntegratedPreviewDragIdx(null)
      setFrameUrls((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const [u] = next.splice(from, 1)
        next.splice(to, 0, u!)
        return next
      })
      setFrameOffsets((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const [x] = next.splice(from, 1)
        next.splice(to, 0, x ?? { dx: 0, dy: 0 })
        return next
      })
      setFrameCrops((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const [x] = next.splice(from, 1)
        next.splice(to, 0, x ?? emptyCrop())
        return next
      })
      setSelected((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const [x] = next.splice(from, 1)
        next.splice(to, 0, x ?? false)
        return next
      })
      setFramePressCounts((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const empty = { up: 0, down: 0, left: 0, right: 0 }
        const [x] = next.splice(from, 1)
        next.splice(to, 0, x ?? empty)
        return next
      })
      setNaturalSizes((prev) => {
        if (from >= prev.length || to >= prev.length) return prev
        const next = [...prev]
        const [x] = next.splice(from, 1)
        next.splice(to, 0, x ?? { w: 1, h: 1 })
        return next
      })
      setCurrentIdx((i) => mapReorderLocalIndex(i, from, to))
      setProCropPreviewIdx((i) => mapReorderLocalIndex(i, from, to))
    },
    [integratedSplit, mapReorderLocalIndex],
  )

  const deleteIntegratedPreviewFrame = useCallback(
    (i: number) => {
      if (!integratedSplit || i < 0) return
      setIntegratedPreviewDragIdx(null)
      setFrameUrls((prev) => (i >= prev.length ? prev : prev.filter((_, j) => j !== i)))
      setFrameOffsets((prev) => prev.filter((_, j) => j !== i))
      setFrameCrops((prev) => prev.filter((_, j) => j !== i))
      setSelected((prev) => prev.filter((_, j) => j !== i))
      setFramePressCounts((prev) => prev.filter((_, j) => j !== i))
      setNaturalSizes((prev) => prev.filter((_, j) => j !== i))
    },
    [integratedSplit],
  )

  const deleteIntegratedPreviewRow = useCallback(
    (rowIdx: number) => {
      if (!integratedSplit) return
      setIntegratedPreviewDragIdx(null)
      const inRow = (i: number) => Math.floor(i / layoutCols) === rowIdx
      setFrameUrls((prev) => prev.filter((_, i) => !inRow(i)))
      setFrameOffsets((prev) => prev.filter((_, i) => !inRow(i)))
      setFrameCrops((prev) => prev.filter((_, i) => !inRow(i)))
      setSelected((prev) => prev.filter((_, i) => !inRow(i)))
      setFramePressCounts((prev) => prev.filter((_, i) => !inRow(i)))
      setNaturalSizes((prev) => prev.filter((_, i) => !inRow(i)))
    },
    [integratedSplit, layoutCols],
  )

  const onIntegratedPreviewColsChange = useCallback(
    (v: number | null) => {
      const c = Math.max(1, Math.min(64, Math.floor(Number(v) || 1)))
      const n = frameUrls.length
      setLayoutCols(c)
      setLayoutRows(Math.max(1, Math.ceil(n / c)))
      if (sheetInputMode === 'transparent') setTransparentLayoutCols(c)
    },
    [frameUrls.length, sheetInputMode],
  )

  return (
    <div className="sprite-adjust-module">
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Text type="secondary">{t('spriteAdjustHint')}</Text>
      <StashDropZone
        onStashDrop={(f) => setFile(f)}
        maxSizeMB={IMAGE_MAX_MB}
      >
        <Dragger
          accept={IMAGE_ACCEPT.join(',')}
          maxCount={1}
          fileList={file ? [{ uid: '1', name: file.name } as UploadFile] : []}
          beforeUpload={(f) => {
            setFile(f)
            return false
          }}
          onRemove={() => setFile(null)}
        >
          <p className="ant-upload-text">{t('imageUploadHint')}</p>
          <p className="ant-upload-hint">{t('imageFormats')}</p>
        </Dragger>
      </StashDropZone>
      {file && originalUrl && integratedSplit && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <Text type="secondary" style={{ fontSize: 12, alignSelf: 'center' }}>{t('sheetProUploadThumbCaption')}</Text>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 96,
                height: 96,
                borderRadius: 8,
                border: '1px solid rgba(154,139,120,0.6)',
                background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 12px 12px',
                overflow: 'hidden',
                flexShrink: 0,
                boxSizing: 'border-box',
              }}
            >
              <img
                src={splitSourceUrl ?? originalUrl}
                alt=""
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'contain',
                  display: 'block',
                  imageRendering: 'pixelated',
                }}
              />
            </div>
            {importPreviewDims && (
              <Text type="secondary" style={{ fontSize: 12, textAlign: 'center', whiteSpace: 'nowrap' }}>
                {t('sheetProUploadThumbSize', { w: importPreviewDims.w, h: importPreviewDims.h })}
              </Text>
            )}
          </div>
          {sheetPreEnabled && !sheetProPreprocessIsNoop(sheetPreOpts) && sheetPreBusy && (
            <Text type="secondary" style={{ fontSize: 11, alignSelf: 'center' }}>{t('sheetPreBusy')}</Text>
          )}
        </div>
      )}
      {file && originalUrl && (
        <>
          {integratedSplit && (
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Text type="secondary" style={{ maxWidth: 720, lineHeight: 1.65 }}>{t('sheetProWorkflowHint')}</Text>
              <div
                style={{
                  border: '1px solid rgba(154,139,120,0.35)',
                  borderRadius: 8,
                  padding: 12,
                  background: 'rgba(228,219,207,0.35)',
                }}
              >
                <Space direction="vertical" size={10} style={{ width: '100%' }}>
                  <Space wrap align="center">
                    <Switch checked={sheetPreEnabled} onChange={setSheetPreEnabled} />
                    <Text strong>{t('sheetPreTitle')}</Text>
                    {sheetPreEnabled && sheetPreBusy && (
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('sheetPreBusy')}</Text>
                    )}
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', maxWidth: 720, lineHeight: 1.6 }}>
                    {t('sheetPreHint')}
                  </Text>
                  {sheetPreEnabled && (
                    <Space direction="vertical" size={8} style={{ width: '100%' }}>
                      <Checkbox checked={sheetPreWatermark} onChange={(e) => setSheetPreWatermark(e.target.checked)}>
                        {t('sheetPreWatermark')}
                      </Checkbox>
                      <Space wrap align="center">
                        <Checkbox checked={sheetPreResizeOn} onChange={(e) => setSheetPreResizeOn(e.target.checked)}>
                          {t('sheetPreResize')}
                        </Checkbox>
                        <InputNumber
                          min={1}
                          max={8192}
                          disabled={!sheetPreResizeOn}
                          value={sheetPreResizeW}
                          onChange={(v) => setSheetPreResizeW(v ?? 256)}
                          style={{ width: 72 }}
                          addonBefore={t('sheetPreResizeW')}
                        />
                        <InputNumber
                          min={1}
                          max={8192}
                          disabled={!sheetPreResizeOn}
                          value={sheetPreResizeH}
                          onChange={(v) => setSheetPreResizeH(v ?? 256)}
                          style={{ width: 72 }}
                          addonBefore={t('sheetPreResizeH')}
                        />
                        <Checkbox
                          disabled={!sheetPreResizeOn}
                          checked={sheetPreResizeKeepAspect}
                          onChange={(e) => setSheetPreResizeKeepAspect(e.target.checked)}
                        >
                          {t('sheetPreResizeKeepAspect')}
                        </Checkbox>
                      </Space>
                      <div>
                        <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>
                          {t('sheetPreMatte')}
                        </Text>
                        <Radio.Group
                          size="small"
                          value={sheetPreMatteMode}
                          onChange={(e) => setSheetPreMatteMode(e.target.value)}
                        >
                          <Radio.Button value="none">{t('sheetPreMatteNone')}</Radio.Button>
                          <Radio.Button value="contiguous">{t('sheetPreMatteContiguous')}</Radio.Button>
                          <Radio.Button value="global">{t('sheetPreMatteGlobal')}</Radio.Button>
                        </Radio.Group>
                        {sheetPreMatteMode !== 'none' && (
                          <Space wrap style={{ marginTop: 8 }}>
                            <InputNumber
                              min={0}
                              max={441}
                              value={sheetPreTol}
                              onChange={(v) => setSheetPreTol(v ?? 80)}
                              style={{ width: 88 }}
                              addonBefore={t('sheetPreTolerance')}
                            />
                            <InputNumber
                              min={0}
                              max={64}
                              value={sheetPreFeather}
                              onChange={(v) => setSheetPreFeather(v ?? 5)}
                              style={{ width: 88 }}
                              addonBefore={t('sheetPreFeather')}
                            />
                          </Space>
                        )}
                      </div>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('sheetPreCropSection')}</Text>
                      <Space wrap align="center">
                        <InputNumber min={0} max={4096} value={sheetPreCropT} onChange={(v) => setSheetPreCropT(v ?? 0)} style={{ width: 72 }} addonBefore={t('batchCropTop')} />
                        <InputNumber min={0} max={4096} value={sheetPreCropB} onChange={(v) => setSheetPreCropB(v ?? 0)} style={{ width: 72 }} addonBefore={t('batchCropBottom')} />
                        <InputNumber min={0} max={4096} value={sheetPreCropL} onChange={(v) => setSheetPreCropL(v ?? 0)} style={{ width: 72 }} addonBefore={t('batchCropLeft')} />
                        <InputNumber min={0} max={4096} value={sheetPreCropR} onChange={(v) => setSheetPreCropR(v ?? 0)} style={{ width: 72 }} addonBefore={t('batchCropRight')} />
                      </Space>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('sheetPrePadSection')}</Text>
                      <Space wrap align="center">
                        <InputNumber min={0} max={4096} value={sheetPrePadT} onChange={(v) => setSheetPrePadT(v ?? 0)} style={{ width: 80 }} addonBefore={t('sheetPrePadTop')} />
                        <InputNumber min={0} max={4096} value={sheetPrePadB} onChange={(v) => setSheetPrePadB(v ?? 0)} style={{ width: 80 }} addonBefore={t('sheetPrePadBottom')} />
                        <InputNumber min={0} max={4096} value={sheetPrePadL} onChange={(v) => setSheetPrePadL(v ?? 0)} style={{ width: 80 }} addonBefore={t('sheetPrePadLeft')} />
                        <InputNumber min={0} max={4096} value={sheetPrePadR} onChange={(v) => setSheetPrePadR(v ?? 0)} style={{ width: 80 }} addonBefore={t('sheetPrePadRight')} />
                      </Space>
                    </Space>
                  )}
                </Space>
              </div>
              <Radio.Group
                value={sheetInputMode}
                onChange={(e) => setSheetInputMode(e.target.value)}
                optionType="button"
                size="small"
              >
                <Radio.Button value="whole">{t('sheetProInputModeWhole')}</Radio.Button>
                {SHEET_PRO_GRID_SPLIT_VISIBLE && (
                  <Radio.Button value="grid">{t('sheetProInputModeGrid')}</Radio.Button>
                )}
                <Radio.Button value="transparent">{t('sheetProInputModeTransparent')}</Radio.Button>
              </Radio.Group>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', maxWidth: 720, lineHeight: 1.6 }}>
                {t('sheetProWholeVsGridHint')}
              </Text>
              {SHEET_PRO_GRID_SPLIT_VISIBLE && sheetInputMode === 'grid' && (
                <Space wrap align="center">
                  <Text type="secondary">{t('imagesToSingleSplitRows')}:</Text>
                  <InputNumber min={1} max={32} value={splitRowsIn} onChange={(v) => setSplitRowsIn(v ?? 2)} style={{ width: 64 }} />
                  <Text type="secondary">{t('imagesToSingleSplitCols')}:</Text>
                  <InputNumber min={1} max={32} value={splitColsIn} onChange={(v) => setSplitColsIn(v ?? 2)} style={{ width: 64 }} />
                  <Button type="primary" loading={splitLoading} onClick={applySplitFromGrid}>
                    {t('sheetProSplitExecGrid')}
                  </Button>
                </Space>
              )}
              {sheetInputMode === 'transparent' && (
                <Space wrap align="center">
                  <Text type="secondary">{t('sheetProTransparentLayoutCols')}:</Text>
                  <InputNumber min={1} max={64} value={transparentLayoutCols} onChange={(v) => setTransparentLayoutCols(v ?? 4)} style={{ width: 64 }} />
                  <Button
                    type="primary"
                    loading={splitLoading}
                    disabled={
                      sheetPreEnabled &&
                      !sheetProPreprocessIsNoop(sheetPreOpts) &&
                      (sheetPreBusy || !splitSourceUrl)
                    }
                    onClick={applySplitTransparent}
                  >
                    {t('sheetProSplitExecTransparent')}
                  </Button>
                </Space>
              )}
            </Space>
          )}
          {(!integratedSplit || sheetInputMode === 'whole') && (
            <Space direction="vertical" size={4}>
              <Space wrap align="center">
                <Text type="secondary">{t('spriteColumns')} N:</Text>
                <InputNumber
                  min={1}
                  max={64}
                  value={integratedSplit ? splitCols : cols}
                  onChange={(v) =>
                    integratedSplit ? setSplitCols(v ?? 8) : setCols(v ?? 8)
                  }
                  style={{ width: 72 }}
                />
                <Text type="secondary">{t('spriteRows')} M:</Text>
                <InputNumber
                  min={1}
                  max={64}
                  value={integratedSplit ? splitRows : rows}
                  onChange={(v) =>
                    integratedSplit ? setSplitRows(v ?? 4) : setRows(v ?? 4)
                  }
                  style={{ width: 72 }}
                />
              </Space>
              {integratedSplit && (
                <Text type="secondary" style={{ fontSize: 12, maxWidth: 720, lineHeight: 1.55 }}>
                  {t('sheetProSplitVsLayoutHint')}
                </Text>
              )}
            </Space>
          )}
          {integratedSplit && SHEET_PRO_GRID_SPLIT_VISIBLE && sheetInputMode === 'grid' && frameUrls.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {t('sheetProLayoutLocked', { cols: splitCols, rows: splitRows })}
            </Text>
          )}
          {frameUrls.length > 0 && (
            <>
              <Text strong style={{ display: 'block' }}>{t('spriteAdjustPreview')}</Text>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>{t('spriteAdjustCheckHint')}</Text>
              {integratedSplit && (
                <Space direction="vertical" size={4} style={{ marginBottom: 12 }}>
                  <Space wrap align="center">
                    <Text type="secondary">{t('imagesToSingleCols')}:</Text>
                    <InputNumber
                      min={1}
                      max={64}
                      value={layoutCols}
                      onChange={(v) => onIntegratedPreviewColsChange(v ?? layoutCols)}
                      style={{ width: 72 }}
                    />
                    <Text type="secondary">{t('sheetProRowsAuto', { rows: layoutRows, n: frameUrls.length })}</Text>
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12 }}>{t('sheetProSplitPreviewManageHint')}</Text>
                </Space>
              )}
              <div
                className="sprite-adjust-grid sprite-adjust-grid-with-headers"
                style={{
                  display: 'grid',
                  gridTemplateColumns: `22px repeat(${gridCols}, minmax(56px, 1fr))`,
                  gridTemplateRows: `22px repeat(${gridRows}, minmax(56px, 1fr))`,
                  gap: 8,
                  overflow: 'auto',
                  alignItems: 'stretch',
                  justifyItems: 'stretch',
                }}
              >
                <div key="corner" className="sprite-adjust-corner" />
                {Array.from({ length: gridCols }, (_, c) => (
                  <div key={`col-wrap-${c}`} className="sprite-adjust-header-cell">
                    <Checkbox
                      checked={isColAllSelected(c)}
                      onChange={() => toggleCol(c)}
                      title={t('spriteAdjustSelectCol')}
                    />
                  </div>
                ))}
                {Array.from({ length: gridRows }, (_, r) => [
                  <div key={`row-wrap-${r}`} className="sprite-adjust-header-cell">
                    <Checkbox
                      checked={isRowAllSelected(r)}
                      onChange={() => toggleRow(r)}
                      title={t('spriteAdjustSelectRow')}
                    />
                  </div>,
                  ...Array.from({ length: gridCols }, (_, c) => {
                    const i = r * gridCols + c
                    const hasFrame = i < frameUrls.length
                    const rowHasFrame = r * gridCols < frameUrls.length
                    return (
                      <div
                        key={i}
                        className="sprite-adjust-cell"
                        style={{
                          position: 'relative',
                          display: 'flex',
                          flexDirection: 'row',
                          width: '100%',
                          maxHeight: '100%',
                          minHeight: 0,
                          aspectRatio: '1',
                          border:
                            hasFrame && selected[i]
                              ? '2px solid #b55233'
                              : integratedPreviewDragIdx === i
                                ? '2px dashed #b55233'
                                : '1px solid rgba(0,0,0,0.1)',
                          borderRadius: 6,
                          overflow: 'hidden',
                          background: hasFrame ? '#e4dbcf' : 'repeating-conic-gradient(#d4cbbf 0% 25%, #e8dfd2 0% 50%) 50% / 12px 12px',
                          boxSizing: 'border-box',
                          opacity: integratedSplit && hasFrame && integratedPreviewDragIdx === i ? 0.65 : 1,
                        }}
                        onDragOver={
                          integratedSplit && hasFrame
                            ? (e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                e.dataTransfer.dropEffect = 'move'
                              }
                            : undefined
                        }
                        onDrop={
                          integratedSplit && hasFrame
                            ? (e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                const from = integratedPreviewDragIdx
                                if (from === null || from === i) return
                                reorderIntegratedPreviewFrames(from, i)
                              }
                            : undefined
                        }
                      >
                        {hasFrame ? (
                          <>
                            <Checkbox
                              checked={!!selected[i]}
                              onChange={() => toggleSelect(i)}
                              style={{
                                position: 'absolute',
                                top: 2,
                                left: 2,
                                zIndex: 1,
                              }}
                            />
                            {integratedSplit && (
                              <>
                                <span
                                  draggable={frameUrls.length > 1}
                                  onDragStart={(e) => {
                                    if (frameUrls.length <= 1) return
                                    e.stopPropagation()
                                    e.dataTransfer.effectAllowed = 'move'
                                    e.dataTransfer.setData('text/plain', String(i))
                                    setIntegratedPreviewDragIdx(i)
                                  }}
                                  onDragEnd={() => setIntegratedPreviewDragIdx(null)}
                                  style={{
                                    position: 'absolute',
                                    top: 2,
                                    left: 22,
                                    width: 18,
                                    height: 18,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'rgba(0,0,0,0.5)',
                                    cursor: frameUrls.length <= 1 ? 'not-allowed' : 'grab',
                                    background: 'rgba(255,255,255,0.85)',
                                    borderRadius: 2,
                                    zIndex: 2,
                                  }}
                                >
                                  <DragOutlined style={{ fontSize: 12 }} />
                                </span>
                                <Button
                                  type="primary"
                                  danger
                                  size="small"
                                  icon={<DeleteOutlined />}
                                  disabled={frameUrls.length <= 1}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    deleteIntegratedPreviewFrame(i)
                                  }}
                                  style={{
                                    position: 'absolute',
                                    top: 2,
                                    right: 32,
                                    width: 18,
                                    height: 18,
                                    minWidth: 18,
                                    padding: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    opacity: 0.92,
                                    fontSize: 10,
                                    zIndex: 2,
                                  }}
                                />
                                {c === 0 && rowHasFrame && (
                                  <Tooltip title={t('imagesToSingleDeleteRow')}>
                                    <Button
                                      type="primary"
                                      danger
                                      size="small"
                                      icon={<DeleteOutlined />}
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        deleteIntegratedPreviewRow(r)
                                      }}
                                      style={{
                                        position: 'absolute',
                                        bottom: 2,
                                        left: 2,
                                        width: 18,
                                        height: 18,
                                        minWidth: 18,
                                        padding: 0,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        opacity: 0.92,
                                        fontSize: 10,
                                        zIndex: 2,
                                      }}
                                    />
                                  </Tooltip>
                                )}
                              </>
                            )}
                            <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                              <ShiftedFrameCanvas
                                src={frameUrls[i]!}
                                dx={frameOffsets[i]?.dx ?? 0}
                                dy={frameOffsets[i]?.dy ?? 0}
                                crop={effectiveFrameCrops[i]}
                                {...(useIntegratedLayoutCanvas ? { layoutCellW: cellW, layoutCellH: cellH } : {})}
                                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                              />
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, padding: 2, flexShrink: 0 }}>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(i, { dy: -1 }, 'up') }}
                                title={t('spriteAdjustShiftUp')}
                                style={shiftBtnStyle}
                              >
                                {(framePressCounts[i]?.up ?? 0) === 0 ? <ArrowUpOutlined style={{ fontSize: 10 }} /> : (framePressCounts[i]?.up ?? 0)}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(i, { dy: 1 }, 'down') }}
                                title={t('spriteAdjustShiftDown')}
                                style={shiftBtnStyle}
                              >
                                {(framePressCounts[i]?.down ?? 0) === 0 ? <ArrowDownOutlined style={{ fontSize: 10 }} /> : (framePressCounts[i]?.down ?? 0)}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(i, { dx: -1 }, 'left') }}
                                title={t('spriteAdjustShiftLeft')}
                                style={shiftBtnStyle}
                              >
                                {(framePressCounts[i]?.left ?? 0) === 0 ? <ArrowLeftOutlined style={{ fontSize: 10 }} /> : (framePressCounts[i]?.left ?? 0)}
                              </button>
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(i, { dx: 1 }, 'right') }}
                                title={t('spriteAdjustShiftRight')}
                                style={shiftBtnStyle}
                              >
                                {(framePressCounts[i]?.right ?? 0) === 0 ? <ArrowRightOutlined style={{ fontSize: 10 }} /> : (framePressCounts[i]?.right ?? 0)}
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    )
                  }),
                ])}
              </div>
              {selectedIndices.length > 0 && (
                <div className="sprite-adjust-anim" style={{ marginTop: 24 }}>
                  <Text strong style={{ display: 'block' }}>{t('spriteAdjustAnimPreview')}</Text>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                    {t('frameAnimPreviewHint', { n: selectedIndices.length, idx: (currentIdx % selectedIndices.length) + 1 })}
                  </Text>
                  {integratedSplit && layoutReady && proCropRefUrl && (
                    <Space direction="vertical" size={8} style={{ width: '100%', marginBottom: 12 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {t('sheetProCellRes')}: {cellW} × {cellH} · {t('sheetProComposedRes')}: {composedW} × {composedH}
                      </Text>
                      <Text strong style={{ fontSize: 13 }}>{t('sheetProCropAllFrames')}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('imagesToSingleCropHint')}</Text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Button
                              type="text"
                              size="small"
                              icon={<CaretLeftOutlined />}
                              disabled={frameUrls.length <= 1 || proCropRefIdx <= 0}
                              onClick={() => setProCropPreviewIdx((i) => Math.max(0, i - 1))}
                            />
                            <CropPreview
                              key={proCropRefUrl}
                              imageUrl={proCropRefUrl}
                              cropTop={integratedEdgeCrop.top}
                              cropBottom={integratedEdgeCrop.bottom}
                              cropLeft={integratedEdgeCrop.left}
                              cropRight={integratedEdgeCrop.right}
                              onChange={({ top, bottom, left, right }) =>
                                setIntegratedEdgeCrop({ top, bottom, left, right })
                              }
                              loadingText={t('cropPreviewLoading')}
                              allowNegative
                            />
                            <Button
                              type="text"
                              size="small"
                              icon={<CaretRightOutlined />}
                              disabled={frameUrls.length <= 1 || proCropRefIdx >= frameUrls.length - 1}
                              onClick={() => setProCropPreviewIdx((i) => Math.min(frameUrls.length - 1, i + 1))}
                            />
                          </div>
                          {frameUrls.length > 1 && (
                            <Text type="secondary" style={{ fontSize: 12 }}>
                              {t('imagesToSingleCropPreviewN', { current: proCropRefIdx + 1, total: frameUrls.length })}
                            </Text>
                          )}
                          {(integratedEdgeCrop.top < 0 ||
                            integratedEdgeCrop.bottom < 0 ||
                            integratedEdgeCrop.left < 0 ||
                            integratedEdgeCrop.right < 0) && (
                            <Text type="secondary" style={{ fontSize: 12 }}>{t('imagesToSingleCropNegativeHint')}</Text>
                          )}
                        </div>
                        <div style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <Space wrap align="center">
                            <InputNumber
                              min={-999}
                              value={integratedEdgeCrop.top}
                              onChange={(v) => setIntegratedEdgeCrop((prev) => ({ ...prev, top: v ?? 0 }))}
                              style={{ width: 72 }}
                              addonBefore={t('batchCropTop')}
                            />
                            <InputNumber
                              min={-999}
                              value={integratedEdgeCrop.bottom}
                              onChange={(v) => setIntegratedEdgeCrop((prev) => ({ ...prev, bottom: v ?? 0 }))}
                              style={{ width: 72 }}
                              addonBefore={t('batchCropBottom')}
                            />
                            <InputNumber
                              min={-999}
                              value={integratedEdgeCrop.left}
                              onChange={(v) => setIntegratedEdgeCrop((prev) => ({ ...prev, left: v ?? 0 }))}
                              style={{ width: 72 }}
                              addonBefore={t('batchCropLeft')}
                            />
                            <InputNumber
                              min={-999}
                              value={integratedEdgeCrop.right}
                              onChange={(v) => setIntegratedEdgeCrop((prev) => ({ ...prev, right: v ?? 0 }))}
                              style={{ width: 72 }}
                              addonBefore={t('batchCropRight')}
                            />
                          </Space>
                          {proCropRefSize && naturalSizes.length === frameUrls.length && (
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {t('sheetProCropRefFrame', {
                                  w: Math.max(1, proCropRefSize.w - integratedEdgeCrop.left - integratedEdgeCrop.right),
                                  h: Math.max(1, proCropRefSize.h - integratedEdgeCrop.top - integratedEdgeCrop.bottom),
                                })}
                              </Text>
                              <Text type="secondary" style={{ fontSize: 12 }}>
                                {t('sheetProCropComposedTotal', {
                                  cw: cellW,
                                  ch: cellH,
                                  tw: composedW,
                                  th: composedH,
                                  cols: gridCols,
                                  rows: gridRows,
                                })}
                              </Text>
                            </Space>
                          )}
                        </div>
                      </div>
                    </Space>
                  )}
                  <Space style={{ marginBottom: 12 }} wrap>
                    <Slider
                      min={0.25}
                      max={4}
                      step={0.25}
                      value={speedScale}
                      onChange={setSpeedScale}
                      style={{ width: 120 }}
                      tooltip={{ formatter: (v) => `${v}×` }}
                    />
                    <Text type="secondary" style={{ fontSize: 12 }}>{speedScale}×</Text>
                    <button
                      type="button"
                      onClick={() => setPlaying((p) => !p)}
                      style={{
                        padding: '6px 16px',
                        border: '1px solid #9a8b78',
                        borderRadius: 4,
                        background: playing ? '#b55233' : '#e4dbcf',
                        color: playing ? '#fff' : '#3d3428',
                        cursor: 'pointer',
                        fontSize: 13,
                        fontWeight: 500,
                      }}
                    >
                      {playing ? t('pause') : t('play')}
                    </button>
                    <button
                      type="button"
                      title={t('prevFrame')}
                      onClick={() => setCurrentIdx((i) => (selectedIndices.length > 0 ? (i - 1 + selectedIndices.length) % selectedIndices.length : 0))}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid #9a8b78',
                        borderRadius: 4,
                        background: '#e4dbcf',
                        color: '#3d3428',
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                    >
                      <StepBackwardOutlined />
                    </button>
                    <button
                      type="button"
                      title={t('nextFrame')}
                      onClick={() => setCurrentIdx((i) => (i + 1) % selectedIndices.length)}
                      style={{
                        padding: '6px 10px',
                        border: '1px solid #9a8b78',
                        borderRadius: 4,
                        background: '#e4dbcf',
                        color: '#3d3428',
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                    >
                      <StepForwardOutlined />
                    </button>
                    <span style={{ marginLeft: 16, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.max(1, z - 1))}
                        disabled={previewZoom <= 1}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #9a8b78',
                          borderRadius: 4,
                          background: '#e4dbcf',
                          color: '#3d3428',
                          cursor: previewZoom <= 1 ? 'not-allowed' : 'pointer',
                          opacity: previewZoom <= 1 ? 0.5 : 1,
                        }}
                      >
                        <MinusOutlined />
                      </button>
                      <Text type="secondary" style={{ fontSize: 12, minWidth: 32, textAlign: 'center' }}>{previewZoom}×</Text>
                      <button
                        type="button"
                        onClick={() => setPreviewZoom((z) => Math.min(8, z + 1))}
                        disabled={previewZoom >= 8}
                        style={{
                          padding: '4px 8px',
                          border: '1px solid #9a8b78',
                          borderRadius: 4,
                          background: '#e4dbcf',
                          color: '#3d3428',
                          cursor: previewZoom >= 8 ? 'not-allowed' : 'pointer',
                          opacity: previewZoom >= 8 ? 0.5 : 1,
                        }}
                      >
                        <PlusOutlined />
                      </button>
                    </span>
                    <span style={{ marginLeft: 16, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>{t('spriteAdjustPreviewBg')}:</Text>
                      <Segmented
                        size="small"
                        value={previewBg === 'checkered' ? 'checkered' : 'solid'}
                        onChange={(v) => setPreviewBg(v === 'solid' ? previewBgColor : 'checkered')}
                        options={[
                          { label: t('spriteAdjustPreviewBgCheckered'), value: 'checkered' },
                          { label: t('spriteAdjustPreviewBgSolid'), value: 'solid' },
                        ]}
                      />
                      {previewBg === 'solid' && (
                        <ColorPicker
                          value={previewBgColor}
                          onChange={(_, hex) => setPreviewBgColor(hex ?? '#e4dbcf')}
                          showText
                          size="small"
                          presets={[
                            { label: '', colors: ['#ffffff', '#e4dbcf', '#c9bfb0', '#808080', '#404040', '#000000'] },
                          ]}
                        />
                      )}
                    </span>
                  </Space>
                  <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 8 }}>
                    <div
                      ref={previewContainerRef}
                      className="sprite-adjust-anim-display"
                      style={{
                        padding: 16,
                        background: previewBg === 'checkered'
                          ? 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px'
                          : previewBgColor,
                        borderRadius: 8,
                        border: '1px solid #9a8b78',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '100%',
                        maxWidth: 480,
                        minHeight: 240,
                        overflow: 'auto',
                        position: 'relative',
                        cursor: fixedPixelMode ? 'crosshair' : undefined,
                      }}
                      onMouseEnter={() => setMouseInPreview(true)}
                      onMouseLeave={() => { setMouseInPreview(false); setPreviewMousePos(null) }}
                      onMouseMove={(e) => {
                        if (!previewContainerRef.current) return
                        const rect = previewContainerRef.current.getBoundingClientRect()
                        setPreviewMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
                      }}
                      onClick={handlePreviewClick}
                    >
                      {displayUrl && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: '100%', minHeight: '100%' }}>
                          <div
                            style={{
                              position: 'relative',
                              display: 'inline-block',
                              width: previewImgSize ? previewImgSize.w * previewZoom : undefined,
                              height: previewImgSize ? previewImgSize.h * previewZoom : undefined,
                              border: '1px solid rgba(154,139,120,0.9)',
                              boxSizing: 'border-box',
                            }}
                          >
                            <ShiftedFrameCanvas
                              ref={previewCanvasRef}
                              src={displayUrl}
                              dx={frameOffsets[displayIdx]?.dx ?? 0}
                              dy={frameOffsets[displayIdx]?.dy ?? 0}
                              crop={effectiveFrameCrops[displayIdx]}
                              {...(useIntegratedLayoutCanvas ? { layoutCellW: cellW, layoutCellH: cellH } : {})}
                              displayWidth={previewImgSize ? previewImgSize.w * previewZoom : undefined}
                              displayHeight={previewImgSize ? previewImgSize.h * previewZoom : undefined}
                              onSize={(w, h) => setPreviewImgSize({ w, h })}
                              onContentSize={(sw, sh) => setPreviewContentSize({ w: sw, h: sh })}
                              style={{ display: 'block', position: 'relative', zIndex: 1 }}
                            />
                            {/* 背景网格线：每 2 像素一格，叠加在图上以辅助对齐 */}
                            {previewImgSize && (
                              <div
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  backgroundImage: `
                                    linear-gradient(to right, rgba(0,0,0,0.06) 1px, transparent 1px),
                                    linear-gradient(to bottom, rgba(0,0,0,0.06) 1px, transparent 1px)
                                  `,
                                  backgroundSize: `${2 * previewZoom}px ${2 * previewZoom}px`,
                                  pointerEvents: 'none',
                                  zIndex: 2,
                                }}
                              />
                            )}
                            {/* 水平、垂直参考中线 */}
                            {previewImgSize && (
                              <>
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: 0,
                                    right: 0,
                                    top: '50%',
                                    height: 1,
                                    background: 'rgba(181,82,51,0.75)',
                                    transform: 'translateY(-50%)',
                                    pointerEvents: 'none',
                                    zIndex: 3,
                                  }}
                                />
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: 0,
                                    bottom: 0,
                                    width: 1,
                                    background: 'rgba(181,82,51,0.75)',
                                    transform: 'translateX(-50%)',
                                    pointerEvents: 'none',
                                    zIndex: 3,
                                  }}
                                />
                              </>
                            )}
                            {/* 分辨率显示 */}
                            {previewImgSize && (
                              <div
                                style={{
                                  position: 'absolute',
                                  left: 4,
                                  bottom: 4,
                                  padding: '2px 6px',
                                  background: 'rgba(0,0,0,0.5)',
                                  color: '#fff',
                                  fontSize: 11,
                                  borderRadius: 4,
                                  pointerEvents: 'none',
                                  zIndex: 4,
                                  maxWidth: 'calc(100% - 8px)',
                                  lineHeight: 1.35,
                                }}
                              >
                                {integratedSplit && layoutReady && previewContentSize
                                  ? `${t('sheetProFrameContentRes')}: ${previewContentSize.w}×${previewContentSize.h} · ${t('sheetProCellRes')}: ${previewImgSize.w}×${previewImgSize.h} · ${t('sheetProComposedRes')}: ${composedW}×${composedH}`
                                  : `${previewImgSize.w} × ${previewImgSize.h}`}
                              </div>
                            )}
                            {fixedPixelFixes.map((fix, idx) => (
                              <div
                                key={idx}
                                style={{
                                  position: 'absolute',
                                  left: fix.imgX * previewZoom,
                                  top: fix.imgY * previewZoom,
                                  width: fix.range * previewZoom,
                                  height: fix.range * previewZoom,
                                  backgroundColor: 'rgba(181,82,51,0.35)',
                                  border: '2px solid #b55233',
                                  boxSizing: 'border-box',
                                  pointerEvents: 'none',
                                  zIndex: 5,
                                }}
                              />
                            ))}
                          </div>
                        </div>
                      )}
                      {fixedPixelMode && mouseInPreview && previewMousePos && previewImgSize && (
                        <div
                          style={{
                            position: 'absolute',
                            left: previewMousePos.x - (fixedPixelRange * previewZoom) / 2,
                            top: previewMousePos.y - (fixedPixelRange * previewZoom) / 2,
                            width: fixedPixelRange * previewZoom,
                            height: fixedPixelRange * previewZoom,
                            border: '2px solid #b55233',
                            borderRadius: 2,
                            pointerEvents: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2, padding: 2, flexShrink: 0 }}>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(displayIdx, { dy: -1 }, 'up') }}
                        title={t('spriteAdjustShiftUp')}
                        style={shiftBtnStyle}
                      >
                        {(framePressCounts[displayIdx]?.up ?? 0) === 0 ? <ArrowUpOutlined style={{ fontSize: 10 }} /> : (framePressCounts[displayIdx]?.up ?? 0)}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(displayIdx, { dy: 1 }, 'down') }}
                        title={t('spriteAdjustShiftDown')}
                        style={shiftBtnStyle}
                      >
                        {(framePressCounts[displayIdx]?.down ?? 0) === 0 ? <ArrowDownOutlined style={{ fontSize: 10 }} /> : (framePressCounts[displayIdx]?.down ?? 0)}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(displayIdx, { dx: -1 }, 'left') }}
                        title={t('spriteAdjustShiftLeft')}
                        style={shiftBtnStyle}
                      >
                        {(framePressCounts[displayIdx]?.left ?? 0) === 0 ? <ArrowLeftOutlined style={{ fontSize: 10 }} /> : (framePressCounts[displayIdx]?.left ?? 0)}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setFrameOffsetAndCount(displayIdx, { dx: 1 }, 'right') }}
                        title={t('spriteAdjustShiftRight')}
                        style={shiftBtnStyle}
                      >
                        {(framePressCounts[displayIdx]?.right ?? 0) === 0 ? <ArrowRightOutlined style={{ fontSize: 10 }} /> : (framePressCounts[displayIdx]?.right ?? 0)}
                      </button>
                    </div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 140 }}>
                      <Button
                        type="primary"
                        loading={gifExporting}
                        disabled={selectedIndices.length === 0}
                        onClick={handleExportGif}
                        block
                      >
                        {t('spriteAdjustExportGif')}
                      </Button>
                      {!integratedSplit &&
                        (!fixedPixelMode ? (
                        <button
                          type="button"
                          disabled={playing}
                          onClick={() => { setPlaying(false); setFixedPixelMode(true) }}
                          style={{
                            padding: '8px 16px',
                            border: '1px solid #9a8b78',
                            borderRadius: 4,
                            background: '#e4dbcf',
                            color: '#3d3428',
                            cursor: playing ? 'not-allowed' : 'pointer',
                            fontSize: 13,
                            fontWeight: 500,
                            opacity: playing ? 0.6 : 1,
                          }}
                        >
                          {t('spriteAdjustFixedPixel')}
                        </button>
                      ) : (
                        <>
                          <Text type="secondary" style={{ fontSize: 12 }}>{t('spriteAdjustFixedPixelHint')}</Text>
                          <div>
                            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>{t('spriteAdjustFixedPixelRange')}</Text>
                            <InputNumber
                              min={1}
                              max={8}
                              value={fixedPixelRange}
                              onChange={(v) => setFixedPixelRange(Math.max(1, Math.min(8, v ?? 1)))}
                              style={{ width: 64 }}
                            />
                          </div>
                          {fixedPixelFixes.length > 0 && (
                            <Space direction="vertical" size={8} style={{ width: '100%' }}>
                              <Space>
                                <button
                                  type="button"
                                  disabled={applyProgress !== null}
                                  onClick={applyFixedPixels}
                                  style={{
                                    padding: '6px 14px',
                                    border: '1px solid #9a8b78',
                                    borderRadius: 4,
                                    background: '#b55233',
                                    color: '#fff',
                                    cursor: applyProgress !== null ? 'not-allowed' : 'pointer',
                                    fontSize: 13,
                                    fontWeight: 500,
                                    opacity: applyProgress !== null ? 0.7 : 1,
                                  }}
                                >
                                  {applyProgress !== null ? t('spriteAdjustFixedPixelApplying') : t('spriteAdjustFixedPixelApply')}
                                </button>
                              <button
                                type="button"
                                disabled={applyProgress !== null}
                                onClick={cancelFixedPixels}
                                style={{
                                  padding: '6px 14px',
                                  border: '1px solid #9a8b78',
                                  borderRadius: 4,
                                  background: '#e4dbcf',
                                  color: '#3d3428',
                                  cursor: applyProgress !== null ? 'not-allowed' : 'pointer',
                                  fontSize: 13,
                                  opacity: applyProgress !== null ? 0.7 : 1,
                                }}
                              >
                                {t('spriteAdjustFixedPixelCancel')}
                              </button>
                            </Space>
                              {applyProgress !== null && (
                                <Progress percent={applyProgress} size="small" status="active" />
                              )}
                            </Space>
                          )}
                          <button
                            type="button"
                            onClick={() => { setFixedPixelMode(false); setFixedPixelFixes([]) }}
                            style={{
                              padding: '6px 14px',
                              border: '1px solid #9a8b78',
                              borderRadius: 4,
                              background: '#e4dbcf',
                              color: '#3d3428',
                              cursor: 'pointer',
                              fontSize: 12,
                            }}
                          >
                            {t('spriteAdjustFixedPixelExit')}
                          </button>
                        </>
                      ))}
                      {!integratedSplit && fixedPixelFixes.length > 0 && (
                        <Text type="secondary" style={{ fontSize: 11 }}>{t('spriteAdjustFixedPixelCount', { n: fixedPixelFixes.length })}</Text>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {frameUrls.length > 0 && (
                <div className="sprite-adjust-recombine" style={{ marginTop: 32, paddingTop: 24, borderTop: '1px solid rgba(154,139,120,0.5)' }}>
                  <Text strong style={{ display: 'block', marginBottom: 4 }}>{t('spriteAdjustRecombine')}</Text>
                  <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
                    {t('spriteAdjustRecombineHint')}
                  </Text>
                  <Space wrap>
                    {integratedSplit && (
                      <Button onClick={downloadFramesZip}>{t('roninProSheetProDownloadZip')}</Button>
                    )}
                    <button
                      type="button"
                      onClick={handleRecombine}
                      disabled={recombining}
                      style={{
                        padding: '8px 20px',
                        border: '1px solid #9a8b78',
                        borderRadius: 4,
                        background: '#b55233',
                        color: '#fff',
                        cursor: recombining ? 'not-allowed' : 'pointer',
                        fontSize: 14,
                        fontWeight: 500,
                        opacity: recombining ? 0.7 : 1,
                      }}
                    >
                      {recombining ? t('spriteAdjustRecombining') : t('spriteAdjustRecombineBtn')}
                    </button>
                    {recombinedUrl && (
                      <a
                        href={recombinedUrl}
                        download={
                          recombinedParams
                            ? `recombined_${gridCols}x${gridRows}_${recombinedParams.cellW}x${recombinedParams.cellH}_${gridCols * recombinedParams.cellW}x${gridRows * recombinedParams.cellH}.png`
                            : 'recombined-sprite.png'
                        }
                        style={{
                          padding: '8px 20px',
                          border: '1px solid #9a8b78',
                          borderRadius: 4,
                          background: '#e4dbcf',
                          color: '#3d3428',
                          textDecoration: 'none',
                          fontSize: 14,
                          fontWeight: 500,
                        }}
                      >
                        {t('spriteAdjustDownloadRecombined')}
                      </a>
                    )}
                  </Space>
                  {recombinedUrl && (
                    <div style={{ marginTop: 12, maxWidth: 480 }}>
                      <img
                        src={recombinedUrl}
                        alt=""
                        style={{ maxWidth: '100%', display: 'block', borderRadius: 6, border: '1px solid #9a8b78', imageRendering: 'pixelated' }}
                      />
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </Space>
    </div>
  )
}
