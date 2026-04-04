import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, ColorPicker, message, Slider, Space, Typography } from 'antd'
import {
  AimOutlined,
  BorderOuterOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EyeOutlined,
  InboxOutlined,
  UndoOutlined,
} from '@ant-design/icons'
import { useLanguage } from '../../i18n/context'
import { useImageStash } from '../../stash/context'

const { Text } = Typography

type Tool = 'brush' | 'eraser' | 'superEraser' | 'selectMove' | 'eyedropper'

type SelRect = { x: number; y: number; w: number; h: number }

/** 将 chunk 以左上角 (atX,atY) 拷入 dest（全图 ImageData），越界跳过 */
function blitImageDataInto(
  dest: ImageData,
  chunk: ImageData,
  atX: number,
  atY: number,
  cw: number,
  ch: number,
) {
  const sw = chunk.width
  const sh = chunk.height
  for (let j = 0; j < sh; j++) {
    for (let i = 0; i < sw; i++) {
      const dx = atX + i
      const dy = atY + j
      if (dx < 0 || dx >= cw || dy < 0 || dy >= ch) continue
      const si = (j * sw + i) * 4
      const di = (dy * cw + dx) * 4
      dest.data[di] = chunk.data[si]!
      dest.data[di + 1] = chunk.data[si + 1]!
      dest.data[di + 2] = chunk.data[si + 2]!
      dest.data[di + 3] = chunk.data[si + 3]!
    }
  }
}

function pointInSelRect(px: number, py: number, r: SelRect): boolean {
  return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h
}

interface ImageFineEditorProps {
  imageUrl: string
  onExport?: (blob: Blob) => void
}

export default function ImageFineEditor({ imageUrl, onExport }: ImageFineEditorProps) {
  const { t } = useLanguage()
  const { addImage } = useImageStash()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [tool, setTool] = useState<Tool>('eraser')
  const [brushColor, setBrushColor] = useState('#000000')
  const [brushSize, setBrushSize] = useState(4)
  const [eraserSize, setEraserSize] = useState(8)
  const [superEraserTolerance, setSuperEraserTolerance] = useState(30)
  const [bgColorEnabled, setBgColorEnabled] = useState(false)
  const [bgColor, setBgColor] = useState('#22c55e')
  const [drawing, setDrawing] = useState(false)
  const [panning, setPanning] = useState(false)
  const lastPanRef = useRef({ x: 0, y: 0 })
  const [selectionRect, setSelectionRect] = useState<SelRect | null>(null)
  const [marqueeActive, setMarqueeActive] = useState<{ ax: number; ay: number; bx: number; by: number } | null>(null)
  const [moveDrag, setMoveDrag] = useState<{ scx: number; scy: number; dix: number; diy: number } | null>(null)
  const selectionRectRef = useRef<SelRect | null>(null)
  const moveDragRef = useRef<typeof moveDrag>(null)
  const marqueeRef = useRef<typeof marqueeActive>(null)
  selectionRectRef.current = selectionRect
  moveDragRef.current = moveDrag
  marqueeRef.current = marqueeActive
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [fitScale, setFitScale] = useState(1)
  const [zoomFactor, setZoomFactor] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const saveDataRef = useRef<ImageData | null>(null)
  const historyRef = useRef<ImageData[]>([])
  const [historyLength, setHistoryLength] = useState(0)
  const MAX_HISTORY = 30
  const zoomFactorRef = useRef(1)
  const fitScaleRef = useRef(1)
  const offsetRef = useRef({ x: 0, y: 0 })
  zoomFactorRef.current = zoomFactor
  fitScaleRef.current = fitScale
  offsetRef.current = offset

  const displayScale = fitScale * zoomFactor

  const eraserCursor = useCallback(() => {
    const d = Math.min(128, Math.max(2, Math.ceil(eraserSize * displayScale)))
    const r = d / 2
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}"><circle cx="${r}" cy="${r}" r="${r - 1}" fill="none" stroke="#333" stroke-width="2"/></svg>`
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${r} ${r}, cell`
  }, [eraserSize, displayScale])

  const eyedropperCursor = useCallback(() => {
    // 简单显示器滴管形状；精细指针不追求像素完美，仅提示工具状态
    const d = Math.min(128, Math.max(2, Math.ceil(brushSize * displayScale)))
    const r = d / 2
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
      <path d="M ${r} ${r - d * 0.25} L ${r + d * 0.18} ${r - d * 0.43} L ${r + d * 0.05} ${r - d * 0.30} Z" fill="#b55233" stroke="#63321f" stroke-width="1"/>
      <circle cx="${r}" cy="${r}" r="${Math.max(1, r - 1)}" fill="none" stroke="#333" stroke-width="2"/>
    </svg>`
    return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${r} ${r}, cell`
  }, [brushSize, displayScale])

  useEffect(() => {
    if (!imageUrl) {
      setImgSize(null)
      setLoadError(false)
      return
    }
    setImgSize(null)
    setLoadError(false)
    const img = new Image()
    img.onload = () => {
      const canvas = canvasRef.current
      if (!canvas) return
      const w = img.naturalWidth || img.width
      const h = img.naturalHeight || img.height
      setImgSize({ w, h })
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(img, 0, 0)
      const id = ctx.getImageData(0, 0, w, h)
      saveDataRef.current = id
      historyRef.current = [new ImageData(new Uint8ClampedArray(id.data), id.width, id.height)]
      setHistoryLength(1)
    }
    img.onerror = () => setLoadError(true)
    img.src = imageUrl
  }, [imageUrl, reloadKey])

  useEffect(() => {
    if (!containerRef.current || !imgSize) return
    const el = containerRef.current
    const updateFitScale = () => {
      const cw = el.clientWidth
      const ch = el.clientHeight
      if (cw <= 0 || ch <= 0) return
      const sx = cw / imgSize.w
      const sy = ch / imgSize.h
      const s = Math.min(sx, sy)
      const z = zoomFactorRef.current
      const ds = s * z
      const off = { x: (cw - imgSize.w * ds) / 2, y: (ch - imgSize.h * ds) / 2 }
      fitScaleRef.current = s
      offsetRef.current = off
      setFitScale(s)
      setOffset(off)
    }
    updateFitScale()
    const ro = new ResizeObserver(updateFitScale)
    ro.observe(el)
    return () => ro.disconnect()
  }, [imgSize])

  const pushHistory = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !imgSize) return
    const id = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
    const clone = new ImageData(new Uint8ClampedArray(id.data), id.width, id.height)
    const h = historyRef.current
    h.push(clone)
    if (h.length > MAX_HISTORY) h.shift()
    setHistoryLength(h.length)
  }, [imgSize])

  const handleUndo = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    const h = historyRef.current
    if (!ctx || !imgSize || h.length <= 1) return
    const prev = h[h.length - 1]
    if (prev) ctx.putImageData(prev, 0, 0)
    h.pop()
    setHistoryLength(h.length)
  }, [imgSize])

  const screenToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      if (!canvasRef.current || !containerRef.current) return null
      const el = containerRef.current
      const rect = el.getBoundingClientRect()
      const cx = clientX - rect.left - el.clientLeft
      const cy = clientY - rect.top - el.clientTop
      const x = (cx - offset.x) / displayScale
      const y = (cy - offset.y) / displayScale
      if (x < 0 || x >= (imgSize?.w ?? 0) || y < 0 || y >= (imgSize?.h ?? 0)) return null
      return { x: Math.floor(x), y: Math.floor(y) }
    },
    [offset, displayScale, imgSize]
  )

  /** 画布像素坐标，越界返回 null（用于点击落笔） */
  const canvasPxFromClient = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (!containerRef.current || !imgSize) return null
      const el = containerRef.current
      const rect = el.getBoundingClientRect()
      const cx = clientX - rect.left - el.clientLeft
      const cy = clientY - rect.top - el.clientTop
      const x = (cx - offset.x) / displayScale
      const y = (cy - offset.y) / displayScale
      const ix = Math.floor(x)
      const iy = Math.floor(y)
      if (ix < 0 || ix >= imgSize.w || iy < 0 || iy >= imgSize.h) return null
      return { x: ix, y: iy }
    },
    [offset, displayScale, imgSize],
  )

  /** 框选拖拽：坐标钳在图内 */
  const canvasPxFromClientClamped = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      if (!containerRef.current || !imgSize) return null
      const el = containerRef.current
      const rect = el.getBoundingClientRect()
      const cx = clientX - rect.left - el.clientLeft
      const cy = clientY - rect.top - el.clientTop
      const x = (cx - offset.x) / displayScale
      const y = (cy - offset.y) / displayScale
      const ix = Math.max(0, Math.min(imgSize.w - 1, Math.floor(x)))
      const iy = Math.max(0, Math.min(imgSize.h - 1, Math.floor(y)))
      return { x: ix, y: iy }
    },
    [offset, displayScale, imgSize],
  )

  const clearSelectUi = useCallback(() => {
    setSelectionRect(null)
    setMarqueeActive(null)
    setMoveDrag(null)
  }, [])

  const switchTool = useCallback(
    (next: Tool) => {
      if (next !== 'selectMove') clearSelectUi()
      setTool(next)
    },
    [clearSelectUi],
  )

  const commitSelectMove = useCallback(
    (sel: SelRect, dix: number, diy: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!ctx || !imgSize) return
      const { x: sx, y: sy, w: sw, h: sh } = sel
      let nx = sx + dix
      let ny = sy + diy
      nx = Math.max(0, Math.min(nx, imgSize.w - sw))
      ny = Math.max(0, Math.min(ny, imgSize.h - sh))
      if (nx === sx && ny === sy) return
      pushHistory()
      const full = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
      const chunk = ctx.getImageData(sx, sy, sw, sh)
      const hole = new ImageData(sw, sh)
      blitImageDataInto(full, hole, sx, sy, imgSize.w, imgSize.h)
      blitImageDataInto(full, chunk, nx, ny, imgSize.w, imgSize.h)
      ctx.putImageData(full, 0, 0)
      setSelectionRect({ x: nx, y: ny, w: sw, h: sh })
    },
    [imgSize, pushHistory],
  )

  const superEraserAt = useCallback(
    (px: number, py: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!ctx || !imgSize) return
      const data = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
      const w = imgSize.w
      const h = imgSize.h
      const idx = (py * w + px) * 4
      const r0 = data.data[idx]
      const g0 = data.data[idx + 1]
      const b0 = data.data[idx + 2]
      const a0 = data.data[idx + 3]
      if (a0 === 0) return
      const tol = superEraserTolerance
      const tol2 = tol * tol
      const dist2 = (r1: number, g1: number, b1: number) =>
        (r1 - r0) ** 2 + (g1 - g0) ** 2 + (b1 - b0) ** 2
      const visited = new Uint8Array(w * h)
      const stack: [number, number][] = [[px, py]]
      visited[py * w + px] = 1
      const dx = [0, 1, 0, -1]
      const dy = [-1, 0, 1, 0]
      while (stack.length > 0) {
        const [x, y] = stack.pop()!
        const i = (y * w + x) * 4
        data.data[i + 3] = 0
        for (let k = 0; k < 4; k++) {
          const nx = x + dx[k]
          const ny = y + dy[k]
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
          const ni = ny * w + nx
          if (visited[ni]) continue
          const ai = (ni * 4) + 3
          if (data.data[ai] === 0) continue
          const ri = data.data[ni * 4]
          const gi = data.data[ni * 4 + 1]
          const bi = data.data[ni * 4 + 2]
          if (dist2(ri, gi, bi) <= tol2) {
            visited[ni] = 1
            stack.push([nx, ny])
          }
        }
      }
      ctx.putImageData(data, 0, 0)
    },
    [imgSize, superEraserTolerance]
  )

  const drawAt = useCallback(
    (px: number, py: number) => {
      const canvas = canvasRef.current
      const ctx = canvas?.getContext('2d')
      if (!ctx || !imgSize) return
      if (tool === 'brush') {
        let r = 0, g = 0, b = 0
        const m = String(brushColor).match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
        if (m) {
          r = parseInt(m[1], 16)
          g = parseInt(m[2], 16)
          b = parseInt(m[3], 16)
        } else {
          const tmp = document.createElement('canvas')
          tmp.width = tmp.height = 1
          const tctx = tmp.getContext('2d')
          if (tctx) {
            tctx.fillStyle = String(brushColor)
            tctx.fillRect(0, 0, 1, 1)
            const d = tctx.getImageData(0, 0, 1, 1).data
            r = d[0]; g = d[1]; b = d[2]
          }
        }
        const data = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
        const cx = px + 0.5
        const cy = py + 0.5
        const size = brushSize
        const radius = size / 2
        const r2 = radius * radius
        const rad = Math.ceil(radius)
        for (let iy = Math.max(0, py - rad); iy <= Math.min(imgSize.h - 1, py + rad); iy++) {
          for (let ix = Math.max(0, px - rad); ix <= Math.min(imgSize.w - 1, px + rad); ix++) {
            const dx = ix + 0.5 - cx
            const dy = iy + 0.5 - cy
            if (dx * dx + dy * dy <= r2) {
              const i = (iy * imgSize.w + ix) * 4
              data.data[i] = r
              data.data[i + 1] = g
              data.data[i + 2] = b
              data.data[i + 3] = 255
            }
          }
        }
        ctx.putImageData(data, 0, 0)
      } else {
        const data = ctx.getImageData(0, 0, imgSize.w, imgSize.h)
        const cx = px + 0.5
        const cy = py + 0.5
        const size = eraserSize
        const r = size / 2
        const r2 = r * r
        const rad = Math.ceil(r)
        for (let iy = Math.max(0, py - rad); iy <= Math.min(imgSize.h - 1, py + rad); iy++) {
          for (let ix = Math.max(0, px - rad); ix <= Math.min(imgSize.w - 1, px + rad); ix++) {
            const dx = ix + 0.5 - cx
            const dy = iy + 0.5 - cy
            if (dx * dx + dy * dy <= r2) {
              const i = (iy * imgSize.w + ix) * 4
              data.data[i + 3] = 0
            }
          }
        }
        ctx.putImageData(data, 0, 0)
      }
      ctx.globalCompositeOperation = 'source-over'
    },
    [tool, brushColor, brushSize, eraserSize, imgSize]
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!imgSize) return
      e.preventDefault()
      if (e.button === 2) {
        setPanning(true)
        lastPanRef.current = { x: e.clientX, y: e.clientY }
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (e.button === 0 && tool === 'selectMove') {
        const p = canvasPxFromClient(e.clientX, e.clientY)
        if (!p) return
        const sel = selectionRectRef.current
        if (sel && pointInSelRect(p.x, p.y, sel)) {
          setMoveDrag({ scx: e.clientX, scy: e.clientY, dix: 0, diy: 0 })
          e.currentTarget.setPointerCapture(e.pointerId)
          return
        }
        setSelectionRect(null)
        setMarqueeActive({ ax: p.x, ay: p.y, bx: p.x, by: p.y })
        e.currentTarget.setPointerCapture(e.pointerId)
        return
      }
      if (e.button === 0) {
        const pt = screenToCanvas(e.clientX, e.clientY)
        if (pt) {
          if (tool === 'eyedropper') {
            const canvas = canvasRef.current
            const ctx = canvas?.getContext('2d')
            if (!ctx) return
            const data = ctx.getImageData(pt.x, pt.y, 1, 1).data
            const r = data[0]!
            const g = data[1]!
            const b = data[2]!
            setBrushColor(`#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`)
            switchTool('brush')
            return
          }
          if (tool === 'superEraser') {
            pushHistory()
            superEraserAt(pt.x, pt.y)
          } else {
            pushHistory()
            setDrawing(true)
            drawAt(pt.x, pt.y)
          }
        }
      }
    },
    [imgSize, tool, screenToCanvas, canvasPxFromClient, drawAt, superEraserAt, pushHistory, switchTool]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (panning) {
        e.preventDefault()
        const dx = e.clientX - lastPanRef.current.x
        const dy = e.clientY - lastPanRef.current.y
        lastPanRef.current = { x: e.clientX, y: e.clientY }
        setOffset((off) => ({ x: off.x + dx, y: off.y + dy }))
        return
      }
      if (marqueeActive) {
        e.preventDefault()
        const p = canvasPxFromClientClamped(e.clientX, e.clientY)
        if (p) setMarqueeActive((m) => (m ? { ...m, bx: p.x, by: p.y } : null))
        return
      }
      if (moveDrag) {
        e.preventDefault()
        setMoveDrag((m) => {
          if (!m) return null
          return {
            ...m,
            dix: Math.round((e.clientX - m.scx) / displayScale),
            diy: Math.round((e.clientY - m.scy) / displayScale),
          }
        })
        return
      }
      if (drawing && imgSize && tool !== 'superEraser') {
        e.preventDefault()
        const pt = screenToCanvas(e.clientX, e.clientY)
        if (pt) drawAt(pt.x, pt.y)
      }
    },
    [panning, drawing, imgSize, tool, marqueeActive, moveDrag, displayScale, screenToCanvas, drawAt, canvasPxFromClientClamped]
  )

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 2) {
        setPanning(false)
        try {
          e.currentTarget.releasePointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      }
      if (e.button === 0) {
        setDrawing(false)
        const mq = marqueeRef.current
        if (mq) {
          const x0 = Math.min(mq.ax, mq.bx)
          const y0 = Math.min(mq.ay, mq.by)
          const x1 = Math.max(mq.ax, mq.bx)
          const y1 = Math.max(mq.ay, mq.by)
          const w = x1 - x0 + 1
          const h = y1 - y0 + 1
          if (w >= 2 && h >= 2) setSelectionRect({ x: x0, y: y0, w, h })
          setMarqueeActive(null)
          try {
            e.currentTarget.releasePointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
        }
        const md = moveDragRef.current
        const sel = selectionRectRef.current
        if (md && sel) {
          if (md.dix !== 0 || md.diy !== 0) commitSelectMove(sel, md.dix, md.diy)
          setMoveDrag(null)
          try {
            e.currentTarget.releasePointerCapture(e.pointerId)
          } catch {
            /* ignore */
          }
        }
      }
    },
    [commitSelectMove],
  )

  const handlePointerLeave = useCallback(() => {
    setDrawing(false)
    setPanning(false)
    setMarqueeActive(null)
    setMoveDrag(null)
  }, [])

  useEffect(() => {
    if (!drawing && !panning) return
    const onUp = () => {
      setDrawing(false)
      setPanning(false)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [drawing, panning])

  useEffect(() => {
    if (!marqueeActive && !moveDrag) return
    const onCancel = () => {
      setMarqueeActive(null)
      setMoveDrag(null)
    }
    window.addEventListener('pointercancel', onCancel)
    return () => window.removeEventListener('pointercancel', onCancel)
  }, [marqueeActive, moveDrag])

  /** WASD：与右键拖拽相同，按屏幕像素平移 offset */
  useEffect(() => {
    if (!imgSize) return
    const keys = new Set<string>()
    let rafId = 0
    let last = performance.now()
    const PAN_PX_PER_SEC = 520

    const step = (now: number) => {
      rafId = requestAnimationFrame(step)
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      if (keys.size === 0) return
      let dx = 0
      let dy = 0
      if (keys.has('a')) dx -= PAN_PX_PER_SEC * dt
      if (keys.has('d')) dx += PAN_PX_PER_SEC * dt
      if (keys.has('w')) dy -= PAN_PX_PER_SEC * dt
      if (keys.has('s')) dy += PAN_PX_PER_SEC * dt
      if (dx === 0 && dy === 0) return
      setOffset((off) => {
        const n = { x: off.x + dx, y: off.y + dy }
        offsetRef.current = n
        return n
      })
    }

    const targetOk = (el: EventTarget | null) => {
      const t = el as HTMLElement
      if (!t) return true
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return false
      if (t.isContentEditable) return false
      return true
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (!targetOk(e.target)) return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const c = e.code
      if (c !== 'KeyW' && c !== 'KeyA' && c !== 'KeyS' && c !== 'KeyD') return
      const k = c === 'KeyW' ? 'w' : c === 'KeyA' ? 'a' : c === 'KeyS' ? 's' : 'd'
      keys.add(k)
      e.preventDefault()
    }

    const onKeyUp = (e: KeyboardEvent) => {
      const c = e.code
      if (c === 'KeyW') keys.delete('w')
      else if (c === 'KeyA') keys.delete('a')
      else if (c === 'KeyS') keys.delete('s')
      else if (c === 'KeyD') keys.delete('d')
    }

    const clearKeys = () => keys.clear()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clearKeys)
    rafId = requestAnimationFrame(step)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearKeys)
      cancelAnimationFrame(rafId)
    }
  }, [imgSize])

  useEffect(() => {
    if (!imgSize) return
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
        e.preventDefault()
        handleUndo()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [imgSize, handleUndo])

  useEffect(() => {
    if (tool !== 'selectMove') return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      e.preventDefault()
      clearSelectUi()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tool, clearSelectUi])

  /** 框选移动：方向键按像素平移选区（与鼠标拖动同一套 commit）；Shift=大步 8px */
  useEffect(() => {
    if (!imgSize || tool !== 'selectMove') return
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)
        return
      if (marqueeRef.current || moveDragRef.current) return
      const sel = selectionRectRef.current
      if (!sel) return
      const code = e.code
      if (
        code !== 'ArrowUp' &&
        code !== 'ArrowDown' &&
        code !== 'ArrowLeft' &&
        code !== 'ArrowRight'
      )
        return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const step = e.shiftKey ? 8 : 1
      let dx = 0
      let dy = 0
      if (code === 'ArrowLeft') dx = -step
      else if (code === 'ArrowRight') dx = step
      else if (code === 'ArrowUp') dy = -step
      else dy = step
      e.preventDefault()
      commitSelectMove(sel, dx, dy)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [imgSize, tool, commitSelectMove])

  useEffect(() => {
    const el = containerRef.current
    if (!el || !imgSize) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left - el.clientLeft
      const cy = e.clientY - rect.top - el.clientTop
      const delta = -Math.sign(e.deltaY) * 0.15
      const fit = fitScaleRef.current
      const off = offsetRef.current
      const z = zoomFactorRef.current
      const zNew = Math.max(0.25, Math.min(4, z * (1 + delta)))
      const scaleOld = fit * z
      const scaleNew = fit * zNew
      if (scaleOld > 0) {
        const ratio = scaleNew / scaleOld
        const offNew = {
          x: cx - (cx - off.x) * ratio,
          y: cy - (cy - off.y) * ratio,
        }
        setOffset(offNew)
        offsetRef.current = offNew
      }
      setZoomFactor(zNew)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [imgSize])

  const handleReset = useCallback(() => {
    zoomFactorRef.current = 1
    setZoomFactor(1)
    setReloadKey((k) => k + 1)
  }, [])

  const handleDownload = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(
      (blob) => {
        if (blob) {
          onExport?.(blob)
          const a = document.createElement('a')
          a.href = URL.createObjectURL(blob)
          a.download = 'fine-edited.png'
          a.click()
          URL.revokeObjectURL(a.href)
        }
      },
      'image/png',
      0.95
    )
  }, [onExport])

  const handleSendToStash = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(
      (blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob)
          addImage(url, 'fine-edited.png')
          message.success(t('imgFineEditorSendToStashSuccess'))
        }
      },
      'image/png',
      0.95
    )
  }, [addImage, t])

  if (loadError) {
    return (
      <div style={{ padding: 48, textAlign: 'center', color: '#c41e3a' }}>
        {t('imgFineEditorLoadError')}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center' }}>
        <Space wrap>
          <Button
            type={tool === 'brush' ? 'primary' : 'default'}
            icon={<EditOutlined />}
            onClick={() => switchTool('brush')}
          >
            {t('imgFineEditorBrush')}
          </Button>
          <Button
            type={tool === 'eraser' ? 'primary' : 'default'}
            icon={<DeleteOutlined />}
            onClick={() => switchTool('eraser')}
          >
            {t('imgFineEditorEraser')}
          </Button>
          <Button
            type={tool === 'eyedropper' ? 'primary' : 'default'}
            icon={<EyeOutlined />}
            onClick={() => switchTool('eyedropper')}
          >
            {t('imgFineEditorEyedropper')}
          </Button>
          <Button
            type={tool === 'superEraser' ? 'primary' : 'default'}
            icon={<AimOutlined />}
            onClick={() => switchTool('superEraser')}
          >
            {t('imgFineEditorSuperEraser')}
          </Button>
          <Button
            type={tool === 'selectMove' ? 'primary' : 'default'}
            icon={<BorderOuterOutlined />}
            onClick={() => switchTool('selectMove')}
          >
            {t('imgFineEditorSelectMove')}
          </Button>
        </Space>
        {tool === 'brush' && (
          <Space wrap align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>{t('imgFineEditorBrushColor')}:</Text>
            <ColorPicker
              value={brushColor}
              onChange={(_: unknown, hex: string) => setBrushColor(hex || '#000000')}
              showText
              size="small"
            />
            <Text type="secondary" style={{ fontSize: 12 }}>{t('imgFineEditorBrushSize')}:</Text>
            <Slider min={1} max={32} value={brushSize} onChange={setBrushSize} style={{ width: 80 }} />
          </Space>
        )}
        {tool === 'eraser' && (
          <Space wrap align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>{t('imgFineEditorEraserSize')}:</Text>
            <Slider min={1} max={64} value={eraserSize} onChange={setEraserSize} style={{ width: 80 }} />
          </Space>
        )}
        {tool === 'superEraser' && (
          <Space wrap align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>{t('imgFineEditorSuperEraserTolerance')}:</Text>
            <Slider min={1} max={100} value={superEraserTolerance} onChange={setSuperEraserTolerance} style={{ width: 80 }} />
          </Space>
        )}
        {tool === 'selectMove' && (
          <Text type="secondary" style={{ fontSize: 12, maxWidth: 420 }}>
            {t('imgFineEditorSelectMoveHint')}
          </Text>
        )}
        <Space wrap align="center">
          <Button size="small" type={bgColorEnabled ? 'primary' : 'default'} onClick={() => setBgColorEnabled(true)}>
            {t('imgFineEditorBgOn')}
          </Button>
          <Button size="small" type={!bgColorEnabled ? 'primary' : 'default'} onClick={() => setBgColorEnabled(false)}>
            {t('imgFineEditorBgOff')}
          </Button>
          {bgColorEnabled && (
            <ColorPicker
              value={bgColor}
              onChange={(_: unknown, hex: string) => setBgColor(hex || '#ffffff')}
              showText
              size="small"
            />
          )}
        </Space>
        <Space wrap>
          <Button size="small" icon={<UndoOutlined />} onClick={handleUndo} disabled={historyLength <= 1}>
            {t('imgFineEditorUndoStep')}
          </Button>
          <Button size="small" icon={<DeleteOutlined />} onClick={handleReset}>
            {t('imgFineEditorReset')}
          </Button>
          <Button type="primary" icon={<DownloadOutlined />} onClick={handleDownload}>
            {t('imgDownload')}
          </Button>
          <Button icon={<InboxOutlined />} onClick={handleSendToStash}>
            {t('imgFineEditorSendToStash')}
          </Button>
        </Space>
      </div>
      <Text type="secondary" style={{ fontSize: 12, lineHeight: 1.5 }}>
        {t('imgFineEditorViewControls')}
      </Text>
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 480,
          minHeight: 320,
          background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
          borderRadius: 8,
          border: '1px solid #9a8b78',
          overflow: 'hidden',
          position: 'relative',
          cursor: imgSize
            ? panning
              ? 'grabbing'
              : tool === 'selectMove'
                ? moveDrag
                  ? 'move'
                  : 'crosshair'
                : tool === 'eyedropper'
                  ? eyedropperCursor()
                : tool === 'brush' || tool === 'superEraser'
                  ? 'crosshair'
                  : tool === 'eraser'
                    ? eraserCursor()
                    : 'grab'
            : 'default',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        tabIndex={0}
        onContextMenu={(e) => e.preventDefault()}
      >
        {!imgSize && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', zIndex: 1 }}>
            {t('imgFineEditorLoading')}
          </div>
        )}
        {imgSize && bgColorEnabled && (
          <div
            style={{
              position: 'absolute',
              left: offset.x,
              top: offset.y,
              width: imgSize.w * displayScale,
              height: imgSize.h * displayScale,
              backgroundColor: bgColor,
              pointerEvents: 'none',
            }}
          />
        )}
        <canvas
          ref={canvasRef}
          style={{
            position: 'absolute',
            left: offset.x,
            top: offset.y,
            width: imgSize ? imgSize.w * displayScale : 0,
            height: imgSize ? imgSize.h * displayScale : 0,
            imageRendering: 'pixelated',
            pointerEvents: 'none',
          }}
        />
        {imgSize && tool === 'selectMove' && marqueeActive && (() => {
          const x = Math.min(marqueeActive.ax, marqueeActive.bx)
          const y = Math.min(marqueeActive.ay, marqueeActive.by)
          const w = Math.abs(marqueeActive.bx - marqueeActive.ax) + 1
          const h = Math.abs(marqueeActive.by - marqueeActive.ay) + 1
          return (
            <div
              style={{
                position: 'absolute',
                left: offset.x + x * displayScale,
                top: offset.y + y * displayScale,
                width: w * displayScale,
                height: h * displayScale,
                border: '2px dashed #0ea5e9',
                boxSizing: 'border-box',
                pointerEvents: 'none',
                zIndex: 3,
                boxShadow: '0 0 0 1px rgba(255,255,255,0.35) inset',
              }}
            />
          )
        })()}
        {imgSize && tool === 'selectMove' && selectionRect && !marqueeActive && (() => {
          const dx = moveDrag?.dix ?? 0
          const dy = moveDrag?.diy ?? 0
          let vx = selectionRect.x + dx
          let vy = selectionRect.y + dy
          vx = Math.max(0, Math.min(vx, imgSize.w - selectionRect.w))
          vy = Math.max(0, Math.min(vy, imgSize.h - selectionRect.h))
          return (
            <div
              style={{
                position: 'absolute',
                left: offset.x + vx * displayScale,
                top: offset.y + vy * displayScale,
                width: selectionRect.w * displayScale,
                height: selectionRect.h * displayScale,
                border: '2px dashed #f59e0b',
                boxSizing: 'border-box',
                pointerEvents: 'none',
                zIndex: 3,
                boxShadow: '0 0 0 1px rgba(0,0,0,0.25) inset',
              }}
            />
          )
        })()}
      </div>
    </div>
  )
}
