import { useCallback, useEffect, useRef, useState } from 'react'

const HIT_PX = 14
const LINE_WIDTH = 2
const NODE_R = 3

export interface RoninProL7SeamPreviewProps {
  imageUrl: string
  imageW: number
  imageH: number
  rowStarts: number[]
  colStarts: number[]
  /** 长度 = 行带数 (rowStarts.length - 1)；每带内竖线 x = colStarts[j] + bandColOffset[r] */
  bandColOffset: number[]
  /** 单行：折线竖线（拐点高度 + 水平偏移），与 bandColOffset 二选一绘制 */
  singleRowPolyline?: { bendY: number; deltaX: number }
  onRowBoundaryChange: (boundaryIndex: number, yPx: number) => void
  onColBoundaryChange: (boundaryIndex: number, xPx: number) => void
}

/**
 * 原图 + 横线 + 按行带分段的竖线（可锯齿）+ 名义竖线虚线参考；拖拽横线/名义竖线。
 */
export default function RoninProL7SeamPreview({
  imageUrl,
  imageW,
  imageH,
  rowStarts,
  colStarts,
  bandColOffset,
  singleRowPolyline,
  onRowBoundaryChange,
  onColBoundaryChange,
}: RoninProL7SeamPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<null | { kind: 'h' | 'v'; idx: number }>(null)
  const [cursor, setCursor] = useState('crosshair')

  const drawRef = useRef<() => void>(() => {})

  const rowsNum = rowStarts.length - 1
  const band =
    bandColOffset.length === rowsNum
      ? bandColOffset
      : Array.from({ length: rowsNum }, (_, i) => bandColOffset[i] ?? 0)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    const img = imgRef.current
    if (!canvas || !container || !img?.complete || imageW < 1 || imageH < 1) return

    const cw = Math.max(1, container.clientWidth)
    const ch = (cw / imageW) * imageH
    const dpr = Math.min(2, typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)

    canvas.width = Math.floor(cw * dpr)
    canvas.height = Math.floor(ch * dpr)
    canvas.style.width = `${cw}px`
    canvas.style.height = `${ch}px`

    const ctx = canvas.getContext('2d')!
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(img, 0, 0, cw, ch)

    const sx = cw / imageW
    const sy = ch / imageH

    ctx.setLineDash([])
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(0, 170, 220, 0.35)'
    ctx.setLineDash([5, 5])
    for (let j = 1; j < colStarts.length - 1; j++) {
      const x = colStarts[j]!
      ctx.beginPath()
      ctx.moveTo(x * sx, 0)
      ctx.lineTo(x * sx, ch)
      ctx.stroke()
    }
    ctx.setLineDash([])

    if (rowsNum === 1 && singleRowPolyline) {
      const H = imageH
      const Lc = Math.max(0, Math.min(H, Math.floor(singleRowPolyline.bendY)))
      const dx = Math.round(singleRowPolyline.deltaX)
      ctx.strokeStyle = 'rgba(255,45,95,0.92)'
      ctx.lineWidth = LINE_WIDTH
      ctx.lineCap = 'square'
      for (let j = 1; j < colStarts.length - 1; j++) {
        const x = colStarts[j]!
        ctx.beginPath()
        if (Lc <= 0) {
          ctx.moveTo(x * sx, 0)
          ctx.lineTo((x + dx) * sx, 0)
          ctx.lineTo((x + dx) * sx, ch)
        } else if (Lc >= H) {
          ctx.moveTo(x * sx, 0)
          ctx.lineTo(x * sx, ch)
        } else {
          ctx.moveTo(x * sx, 0)
          ctx.lineTo(x * sx, Lc * sy)
          ctx.lineTo((x + dx) * sx, Lc * sy)
          ctx.lineTo((x + dx) * sx, ch)
        }
        ctx.stroke()
      }
      const bendR = 6
      const drawKnot = (px: number, py: number) => {
        ctx.beginPath()
        ctx.fillStyle = 'rgba(255, 245, 160, 1)'
        ctx.strokeStyle = 'rgba(120, 20, 40, 0.95)'
        ctx.lineWidth = 2
        ctx.arc(px, py, bendR, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
      if (Lc > 0 && Lc < H) {
        const py = Lc * sy
        for (let j = 1; j < colStarts.length - 1; j++) {
          const x = colStarts[j]!
          drawKnot(x * sx, py)
          if (Math.abs(dx) > 0.5) {
            drawKnot((x + dx) * sx, py)
          }
        }
      } else if (Lc <= 0 && Math.abs(dx) > 0.5) {
        for (let j = 1; j < colStarts.length - 1; j++) {
          const x = colStarts[j]!
          drawKnot(x * sx, 0)
          drawKnot((x + dx) * sx, 0)
        }
      }
      return
    }

    ctx.strokeStyle = 'rgba(255,45,95,0.92)'
    ctx.lineWidth = LINE_WIDTH
    ctx.lineCap = 'square'

    for (let i = 1; i < rowStarts.length - 1; i++) {
      const y = rowStarts[i]!
      ctx.beginPath()
      ctx.moveTo(0, y * sy)
      ctx.lineTo(cw, y * sy)
      ctx.stroke()
    }

    for (let r = 0; r < rowsNum; r++) {
      const off = band[r] ?? 0
      const y0 = rowStarts[r]!
      const y1 = rowStarts[r + 1]!
      for (let j = 1; j < colStarts.length - 1; j++) {
        const x = colStarts[j]! + off
        ctx.beginPath()
        ctx.moveTo(x * sx, y0 * sy)
        ctx.lineTo(x * sx, y1 * sy)
        ctx.stroke()
      }
    }

    for (let r = 1; r < rowsNum; r++) {
      const y = rowStarts[r]!
      const py = y * sy
      for (let j = 1; j < colStarts.length - 1; j++) {
        const x0 = colStarts[j]! + (band[r - 1] ?? 0)
        const x1 = colStarts[j]! + (band[r] ?? 0)
        if (Math.abs(x0 - x1) < 0.5) continue
        ctx.beginPath()
        ctx.moveTo(x0 * sx, py)
        ctx.lineTo(x1 * sx, py)
        ctx.stroke()
      }
    }

    ctx.fillStyle = 'rgba(255,230,120,0.95)'
    ctx.strokeStyle = 'rgba(180,30,60,0.85)'
    ctx.lineWidth = 1
    for (let r = 1; r < rowsNum; r++) {
      const py = rowStarts[r]! * sy
      for (let j = 1; j < colStarts.length - 1; j++) {
        const x0 = colStarts[j]! + (band[r - 1] ?? 0)
        const x1 = colStarts[j]! + (band[r] ?? 0)
        if (Math.abs(x0 - x1) < 0.5) continue
        const mxx = ((x0 + x1) / 2) * sx
        ctx.beginPath()
        ctx.arc(mxx, py, NODE_R, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      }
    }
  }, [imageW, imageH, rowStarts, colStarts, band, rowsNum, singleRowPolyline])

  drawRef.current = draw

  useEffect(() => {
    const img = new Image()
    let cancelled = false
    img.onload = () => {
      if (cancelled) return
      imgRef.current = img
      drawRef.current()
    }
    img.onerror = () => {
      imgRef.current = null
    }
    img.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [imageUrl])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => draw())
    ro.observe(el)
    return () => ro.disconnect()
  }, [draw])

  const pickDrag = useCallback(
    (clientX: number, clientY: number): { kind: 'h' | 'v'; idx: number } | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const mx = clientX - rect.left
      const my = clientY - rect.top
      const cw = rect.width
      const ch = rect.height
      if (cw < 1 || ch < 1) return null

      let best: { kind: 'h' | 'v'; idx: number; dist: number } | null = null

      for (let i = 1; i < rowStarts.length - 1; i++) {
        const y = rowStarts[i]!
        const py = (y / imageH) * ch
        const d = Math.abs(my - py)
        if (d <= HIT_PX && (!best || d < best.dist)) {
          best = { kind: 'h', idx: i, dist: d }
        }
      }
      for (let j = 1; j < colStarts.length - 1; j++) {
        const x = colStarts[j]!
        const px = (x / imageW) * cw
        const d = Math.abs(mx - px)
        if (d <= HIT_PX && (!best || d < best.dist)) {
          best = { kind: 'v', idx: j, dist: d }
        }
      }
      return best ? { kind: best.kind, idx: best.idx } : null
    },
    [rowStarts, colStarts, imageW, imageH]
  )

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const hit = pickDrag(e.clientX, e.clientY)
    if (!hit) return
    dragRef.current = hit
    e.currentTarget.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = dragRef.current
    if (!d) {
      const hit = pickDrag(e.clientX, e.clientY)
      setCursor(
        hit ? (hit.kind === 'h' ? 'ns-resize' : 'ew-resize') : 'crosshair'
      )
      return
    }
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const cw = rect.width
    const ch = rect.height
    if (cw < 1 || ch < 1) return

    if (d.kind === 'h') {
      const my = e.clientY - rect.top
      const yPx = Math.round((my / ch) * imageH)
      onRowBoundaryChange(d.idx, yPx)
    } else {
      const mx = e.clientX - rect.left
      const xPx = Math.round((mx / cw) * imageW)
      onColBoundaryChange(d.idx, xPx)
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragRef.current) {
      dragRef.current = null
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
  }

  const onPointerLeave = () => {
    if (!dragRef.current) setCursor('crosshair')
  }

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        maxWidth: 920,
        borderRadius: 8,
        overflow: 'hidden',
        border: '1px solid #9a8b78',
        background:
          'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
        lineHeight: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
        onPointerCancel={onPointerUp}
        style={{
          width: '100%',
          height: 'auto',
          display: 'block',
          cursor,
          touchAction: 'none',
          imageRendering: 'pixelated',
        }}
      />
    </div>
  )
}
