import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button, Checkbox, Slider, Typography } from 'antd'
import { useLanguage } from '../../i18n/context'
import { ANIMS, DEFAULT_CHAR_URL, extractFrame, REGIONS } from './infiniteMapSpriteData'
import {
  BlobWorld,
  decodeBlobAtlasFromImage,
  describeBlobTerrain,
  findWalkableTileCenter,
  isBlobTileLandNotWater,
  isBlobTileWalkable,
  sampleBlobAtlas,
  type BlobAtlas,
} from './blobTerrain'
import {
  createMonsterSwarm,
  loadMonsterImages,
  MONSTER_COLS,
  MONSTER_ROWS,
  stepMonster,
  velocityToMonsterRow,
  type MonsterInst,
} from './infiniteMapMonsters'

const { Text } = Typography

const BGM_URL = `${import.meta.env.BASE_URL}map/ff6.ogg`
/** 与 public/map/blob/map.html 一致：山 001 / 平地 004 / 水 007；layout 3×24 */
const BLOB_BASE = `${import.meta.env.BASE_URL}map/blob/`
const TREE_SNOW_URL = `${import.meta.env.BASE_URL}map/trees/treesnow.png`
const BLOB_FRAME_MTN = `${BLOB_BASE}frame_001.png`
const BLOB_FRAME_NORM = `${BLOB_BASE}frame_004.png`
const BLOB_FRAME_NORM_X1 = `${BLOB_BASE}frame_004X1.png`
const BLOB_FRAME_NORM_X2 = `${BLOB_BASE}frame_004X2.png`
/** 平地 004 中与「四周同类」最常见子格对应的图集下标（0-based，即 map 示意里的中心块） */
const NORM_CENTER_SHEET_INDEX = 4
/**
 * 仅对上述中心格：004X1 / 004X2 点缀概率（千分比，0–1000）。
 * 例：各 25 → 约 2.5% 用 X1、2.5% 用 X2，其余约 95% 仍为 frame_004。
 * 调大数字 = 变种略多；两者不必相等。
 */
const NORM_CENTER_X1_PERMILLE = 28
const NORM_CENTER_X2_PERMILLE = 28
/**
 * 水格贴图：与 map.html 一致为 frame_007。
 * 若日后为同一 3×24 布局增加多帧水动画，可在此追加 URL（勿混入 001/004 山与平地）。
 */
const BLOB_WATER_ANIM_FRAMES = [`${BLOB_BASE}frame_007.png`]

/** 与 public/map/blob/map.html 滑条一致：value/100 → BlobWorld.seaLevel / mtnTh */
const TERRAIN_SEA_MIN = 0
const TERRAIN_SEA_MAX = 58
const TERRAIN_MTN_MIN = 25
const TERRAIN_MTN_MAX = 75

/** 逻辑分辨率（与 ControlTest topdown 一致） */
const W = 480
const H = 320
/** 显示为 16:9：从画面上方裁掉一条，只保留下方区域 */
const DISPLAY_H = Math.round((W * 9) / 16)
const CROP_TOP = H - DISPLAY_H
/** 透视：地平线提高 = 俯仰略抬，远景地面条带移出可渲染带，少算 blob */
const HORIZON = Math.floor(H * 0.1)
const FOCAL = 250
const CAM_HEIGHT = 80
const PLAYER_DZ = 120
/**
 * 距地平线过近的扫描行：dz 极大，对应极远地面；不跑 blob（与视野外一致，省算力）。
 * 这些行改画远景雾色。
 */
const TERRAIN_MIN_ROW = 14

/** 世界格尺寸（blob 地块） */
const TILE_WORLD = 16
const MOVE_SPEED = 1
const RUN_MUL = 2

/** FF6 开篇风格：斜飘、远景小点 / 近景大块，整数像素绘制 */
const FALL_SNOW_COUNT = 340
type FallLayer = 0 | 1 | 2
type FallFlake = {
  x: number
  y: number
  vx: number
  vy: number
  wobble: number
  layer: FallLayer
  /** 同层内形状变体（像素图案） */
  variant: number
}

function rgbForSnowFlake(layer: FallLayer, wobble: number): [number, number, number] {
  const t = Math.sin(wobble * 0.37) * 14
  if (layer === 0) return [148 + t, 168 + t, 202 + t]
  if (layer === 1) return [188 + t, 208 + t, 238 + t]
  return [228 + t, 236 + t, 252 + t]
}

/** 单像素点（远景） */
function drawSnowFar(ctx: CanvasRenderingContext2D, xi: number, yi: number, rgb: [number, number, number]) {
  const [r, g, b] = rgb
  ctx.fillStyle = `rgb(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)})`
  ctx.fillRect(xi, yi, 1, 1)
}

/** 2×2 实块（中景） */
function drawSnowMid(ctx: CanvasRenderingContext2D, xi: number, yi: number, rgb: [number, number, number]) {
  const [r, g, b] = rgb
  ctx.fillStyle = `rgb(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)})`
  ctx.fillRect(xi, yi, 2, 2)
}

/** 近景：3×3 / 4×4 整数像素簇（非矢量缩放，保持 SNES 块感） */
function drawSnowNear(
  ctx: CanvasRenderingContext2D,
  xi: number,
  yi: number,
  rgb: [number, number, number],
  variant: number,
  cw: number,
  ch: number,
) {
  const [r0, g0, b0] = rgb
  const r = Math.floor(r0)
  const g = Math.floor(g0)
  const b = Math.floor(b0)
  const rHi = Math.min(255, r + 24)
  const gHi = Math.min(255, g + 20)
  const bHi = Math.min(255, b + 14)
  const pat = variant % 4
  const plot = (dx: number, dy: number, hi: boolean) => {
    const x = xi + dx
    const y = yi + dy
    if (x < 0 || x >= cw || y < 0 || y >= ch) return
    ctx.fillStyle = hi ? `rgb(${rHi},${gHi},${bHi})` : `rgb(${r},${g},${b})`
    ctx.fillRect(x, y, 1, 1)
  }
  if (pat === 0) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        plot(dx, dy, dx === 1 && dy === 1)
      }
    }
  } else if (pat === 1) {
    for (let dy = 0; dy < 3; dy++) {
      for (let dx = 0; dx < 3; dx++) {
        plot(dx, dy, (dx + dy) % 2 === 0)
      }
    }
  } else if (pat === 2) {
    const pts: [number, number][] = [
      [1, 0],
      [2, 0],
      [0, 1],
      [1, 1],
      [2, 1],
      [3, 1],
      [1, 2],
      [2, 2],
      [3, 2],
      [2, 3],
      [3, 3],
    ]
    for (let i = 0; i < pts.length; i++) {
      const [dx, dy] = pts[i]!
      plot(dx, dy, i % 2 === 0)
    }
  } else {
    for (let dy = 0; dy < 4; dy++) {
      for (let dx = 0; dx < 4; dx++) {
        const d = Math.abs(dx - 1.5) + Math.abs(dy - 1.5)
        if (d < 2.65) plot(dx, dy, d < 1.25)
      }
    }
  }
}

let shadowTexCache: HTMLCanvasElement | null = null
function getShadowTexture(): HTMLCanvasElement {
  if (shadowTexCache) return shadowTexCache
  const c = document.createElement('canvas')
  const w = 28
  const h = 10
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = 'rgba(0,0,0,0.45)'
  ctx.beginPath()
  ctx.ellipse(w / 2, h / 2, w / 2 - 1, h / 2 - 1, 0, 0, Math.PI * 2)
  ctx.fill()
  shadowTexCache = c
  return c
}

/** 黑白马赛克：图集未加载时的兜底 */
function mosaicRgb(tileIx: number, tileIz: number): [number, number, number] {
  const dark = ((tileIx + tileIz) & 1) === 0
  const v = dark ? 28 : 228
  return [v, v, v]
}

function pickWaterAtlas(waterFrames: (BlobAtlas | null)[], animT: number): BlobAtlas | null {
  const n = waterFrames.length
  if (n === 0) return null
  const phase = Math.floor(animT / 220) % n
  for (let k = 0; k < n; k++) {
    const a = waterFrames[(phase + k) % n]
    if (a) return a
  }
  return null
}

type BlobTilePick = ReturnType<BlobWorld['sampleTileIndex']>

function pickNormAtlasForSheet(
  sheetIndex: number,
  tix: number,
  tiz: number,
  base: BlobAtlas | null,
  x1: BlobAtlas | null,
  x2: BlobAtlas | null,
): BlobAtlas | null {
  if (sheetIndex !== NORM_CENTER_SHEET_INDEX) return base
  const h = (Math.imul(tix, 92837111) ^ Math.imul(tiz, 689287499)) >>> 0
  const u = h % 1000
  const c1 = Math.min(1000, Math.max(0, NORM_CENTER_X1_PERMILLE))
  const c2 = Math.min(Math.max(0, NORM_CENTER_X2_PERMILLE), 1000 - c1)
  if (u < c1 && x1) return x1
  if (u < c1 + c2 && x2) return x2
  return base
}

function sampleBlobTerrainRgbResolved(
  atlasMtn: BlobAtlas | null,
  atlasNorm: BlobAtlas | null,
  atlasNormX1: BlobAtlas | null,
  atlasNormX2: BlobAtlas | null,
  waterFrames: (BlobAtlas | null)[],
  animT: number,
  pick: BlobTilePick,
  tix: number,
  tiz: number,
  wx: number,
  wz: number,
): [number, number, number] {
  const { kind, sheetIndex } = pick
  if (kind === 'water') {
    const wa = pickWaterAtlas(waterFrames, animT)
    if (!wa) return mosaicRgb(tix, tiz)
    return sampleBlobAtlas(wa, sheetIndex, wx, wz, TILE_WORLD)
  }
  if (kind === 'mtn') {
    if (!atlasMtn) return mosaicRgb(tix, tiz)
    return sampleBlobAtlas(atlasMtn, sheetIndex, wx, wz, TILE_WORLD)
  }
  const land = pickNormAtlasForSheet(sheetIndex, tix, tiz, atlasNorm, atlasNormX1, atlasNormX2)
  if (!land) return mosaicRgb(tix, tiz)
  return sampleBlobAtlas(land, sheetIndex, wx, wz, TILE_WORLD)
}

function screenToWorld(sx: number, sy: number, camX: number, camZ: number): { wx: number; wz: number } | null {
  const row = sy - HORIZON
  if (row <= 0) return null
  const dz = (FOCAL * CAM_HEIGHT) / row
  const wx = camX + ((sx - W / 2) * dz) / FOCAL
  const wz = camZ + dz
  return { wx, wz }
}

function worldToScreen(wx: number, wz: number, camX: number, camZ: number): { sx: number; sy: number } | null {
  const dz = wz - camZ
  if (dz <= 0) return null
  const sx = W / 2 + ((wx - camX) * FOCAL) / dz
  const row = (FOCAL * CAM_HEIGHT) / dz
  const sy = HORIZON + row
  return { sx, sy }
}

const TERRAIN_SY_START = HORIZON + TERRAIN_MIN_ROW

/** 地平线以下、尚未进入 blob 带的行：远景雾（无地块采样） */
function farHazeRgb(sy: number): [number, number, number] {
  const t = (sy - HORIZON) / Math.max(1, TERRAIN_MIN_ROW)
  const g = Math.floor(14 + t * 22)
  const b = Math.floor(22 + t * 28)
  return [g, b, Math.min(48, b + 8)]
}

/** 当前帧地面在屏幕上的世界格包络，用于 chunk 预加载（不加载视野外） */
function visibleGroundTileBounds(camX: number, camZ: number): { tix0: number; tix1: number; tiz0: number; tiz1: number } | null {
  const corners: [number, number][] = [
    [0, TERRAIN_SY_START],
    [W - 1, TERRAIN_SY_START],
    [0, H - 1],
    [W - 1, H - 1],
  ]
  let minWx = Infinity
  let maxWx = -Infinity
  let minWz = Infinity
  let maxWz = -Infinity
  for (const [sx, sy] of corners) {
    const h = screenToWorld(sx + 0.5, sy + 0.5, camX, camZ)
    if (!h) continue
    minWx = Math.min(minWx, h.wx)
    maxWx = Math.max(maxWx, h.wx)
    minWz = Math.min(minWz, h.wz)
    maxWz = Math.max(maxWz, h.wz)
  }
  if (!Number.isFinite(minWx)) return null
  const pad = TILE_WORLD * 6
  return {
    tix0: Math.floor((minWx - pad) / TILE_WORLD),
    tix1: Math.floor((maxWx + pad) / TILE_WORLD),
    tiz0: Math.floor((minWz - pad) / TILE_WORLD),
    tiz1: Math.floor((maxWz + pad) / TILE_WORLD),
  }
}

/** 7×7 世界格为一块；块内 hash 决定是否密林，格内 hash 决定是否落树 */
const TREE_CLUSTER_BLOCK = 7
const TREE_HASH_BASE = 0x54726565

function treeCellHash(tix: number, tiz: number, salt: number): number {
  let h = Math.imul(tix, 374761393) ^ Math.imul(tiz, 668265263) ^ salt
  h ^= h >>> 16
  h = Math.imul(h, 2246822519)
  h ^= h >>> 13
  h = Math.imul(h, 3266489917)
  return h >>> 0
}

function treeU01(h: number): number {
  return h / 4294967296
}

/**
 * 平地与山地（陆地）均可种树；仅水域不种。
 * 独立树：全陆地按 lonePct 缩放；成片树：仅块 hash 落入林带时按 patchPct 缩放（第二哈希，与独立树独立）。
 */
function shouldPlaceSnowTreeOnTile(
  tix: number,
  tiz: number,
  patchDensityPct: number,
  loneDensityPct: number,
): boolean {
  const patchMul = Math.max(0, Math.min(100, patchDensityPct)) / 100
  const loneMul = Math.max(0, Math.min(100, loneDensityPct)) / 100
  const pLone = loneMul * 0.12
  const localLone = treeU01(treeCellHash(tix, tiz, TREE_HASH_BASE + 3331))
  if (localLone < pLone) return true

  const bx = Math.floor(tix / TREE_CLUSTER_BLOCK)
  const bz = Math.floor(tiz / TREE_CLUSTER_BLOCK)
  const blockV = treeU01(treeCellHash(bx, bz, TREE_HASH_BASE))
  let pPatchCap = 0
  if (blockV > 0.64) pPatchCap = 0.52
  else if (blockV > 0.5) pPatchCap = 0.24
  if (pPatchCap <= 0 || patchMul <= 0) return false
  const pPatch = pPatchCap * patchMul
  const localPatch = treeU01(treeCellHash(tix, tiz, TREE_HASH_BASE + 7777))
  return localPatch < pPatch
}

function snowTreeFeetWorld(tix: number, tiz: number): { wx: number; wz: number } {
  const h1 = treeCellHash(tix, tiz, TREE_HASH_BASE + 11)
  const h2 = treeCellHash(tix, tiz, TREE_HASH_BASE + 22)
  const margin = 3
  const span = Math.max(1, TILE_WORLD - margin * 2)
  return {
    wx: tix * TILE_WORLD + margin + (h1 % span),
    wz: tiz * TILE_WORLD + margin + (h2 % span),
  }
}

const TREE_REF_DZ = 92
const TREE_DISPLAY_SCALE = 1.5
const MONSTER_REF_DZ = 90
const MONSTER_DISPLAY_SCALE = 1.12
const MONSTER_FEET_DOWN_SRC = 6
const MONSTER_COUNT_MAX = 80
/** 树根世界坐标对齐地块上的点；贴地偏移为额外下移（纹理像素 × 透视缩放 sc），修正图底部透明留白 */
const TREE_FEET_DOWN_MIN = -24
const TREE_FEET_DOWN_MAX = 40

function drawSnowTreesSorted(
  ctx: CanvasRenderingContext2D,
  treeImg: HTMLImageElement,
  camX: number,
  camZ: number,
  list: { wx: number; wz: number }[],
  /** 正值：整图下移，树根更贴地（逻辑为「源图素」再乘当前 sc） */
  feetDownSrcPx: number,
) {
  const refRow = (FOCAL * CAM_HEIGHT) / TREE_REF_DZ
  const iw = treeImg.naturalWidth || 1
  const ih = treeImg.naturalHeight || 1
  ctx.save()
  ctx.imageSmoothingEnabled = false
  for (const t of list) {
    const feet = worldToScreen(t.wx, t.wz, camX, camZ)
    if (!feet) continue
    const dz = t.wz - camZ
    if (dz <= 0) continue
    const row = (FOCAL * CAM_HEIGHT) / dz
    const syDisp = feet.sy - CROP_TOP
    if (syDisp < -110 || syDisp > DISPLAY_H + 110) continue
    if (feet.sx < -110 || feet.sx > W + 110) continue
    const sc = Math.max(0.26, Math.min(1.28, row / refRow)) * TREE_DISPLAY_SCALE
    const dw = iw * sc
    const dh = ih * sc
    const yOff = feetDownSrcPx * sc
    ctx.drawImage(treeImg, feet.sx - dw * 0.5, syDisp - dh + yOff, dw, dh)
  }
  ctx.restore()
}

function drawMonstersSorted(
  ctx: CanvasRenderingContext2D,
  imgs: HTMLImageElement[],
  list: MonsterInst[],
  camX: number,
  camZ: number,
) {
  const refRow = (FOCAL * CAM_HEIGHT) / MONSTER_REF_DZ
  ctx.save()
  ctx.imageSmoothingEnabled = false
  for (const m of list) {
    const img = imgs[m.sheetIndex]
    if (!img?.complete || img.naturalWidth < MONSTER_COLS || img.naturalHeight < MONSTER_ROWS) continue
    const cw = Math.floor(img.naturalWidth / MONSTER_COLS)
    const ch = Math.floor(img.naturalHeight / MONSTER_ROWS)
    if (cw < 1 || ch < 1) continue
    const row = velocityToMonsterRow(m.vx, m.vz)
    const col = m.frame % MONSTER_COLS
    const feet = worldToScreen(m.wx, m.wz, camX, camZ)
    if (!feet) continue
    const dz = m.wz - camZ
    if (dz <= 0) continue
    const rowH = (FOCAL * CAM_HEIGHT) / dz
    const syDisp = feet.sy - CROP_TOP
    if (syDisp < -130 || syDisp > DISPLAY_H + 130) continue
    if (feet.sx < -130 || feet.sx > W + 130) continue
    const sc = Math.max(0.22, Math.min(1.35, rowH / refRow)) * MONSTER_DISPLAY_SCALE
    const dw = cw * sc
    const dh = ch * sc
    const yOff = MONSTER_FEET_DOWN_SRC * sc
    ctx.drawImage(
      img,
      col * cw,
      row * ch,
      cw,
      ch,
      feet.sx - dw * 0.5,
      syDisp - dh + yOff,
      dw,
      dh,
    )
  }
  ctx.restore()
}

/** 全屏压暗 + 径向暗角；dimPct / vignettePct 为 0–100 */
function drawScenePostFx(
  ctx: CanvasRenderingContext2D,
  cw: number,
  ch: number,
  dimPct: number,
  vignettePct: number,
) {
  const d = Math.max(0, Math.min(100, dimPct))
  const v = Math.max(0, Math.min(100, vignettePct))
  if (d < 0.5 && v < 0.5) return
  ctx.save()
  if (d > 0.5) {
    const a = (d / 100) * 0.62
    ctx.fillStyle = `rgba(0,0,0,${a})`
    ctx.fillRect(0, 0, cw, ch)
  }
  if (v > 0.5) {
    const cx = cw * 0.5
    const cy = ch * 0.5
    /** 内圈尽量小，外圈盖住四角，暗角才明显 */
    const r0 = Math.min(cw, ch) * 0.1
    const r1 = Math.hypot(cw * 0.52, ch * 0.52)
    const t = Math.pow(v / 100, 0.92)
    const edgeA = Math.min(0.94, t * 0.93)
    const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1)
    g.addColorStop(0, 'rgba(0,0,0,0)')
    g.addColorStop(0.32, 'rgba(0,0,0,0)')
    g.addColorStop(0.62, `rgba(0,0,0,${edgeA * 0.22})`)
    g.addColorStop(0.82, `rgba(0,0,0,${edgeA * 0.62})`)
    g.addColorStop(1, `rgba(0,0,0,${edgeA})`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, cw, ch)
  }
  ctx.restore()
}

function createFallSnowFlakes(): FallFlake[] {
  const flakes: FallFlake[] = []
  for (let i = 0; i < FALL_SNOW_COUNT; i++) {
    const roll = Math.random()
    const layer: FallLayer = roll < 0.48 ? 0 : roll < 0.82 ? 1 : 2
    const slow = layer === 0
    const mid = layer === 1
    flakes.push({
      x: Math.random() * W,
      y: Math.random() * (DISPLAY_H + 100) - 50,
      vx: 8 + (slow ? 3 : mid ? 12 : 20) + Math.random() * 14,
      vy: (slow ? 18 : mid ? 42 : 72) + Math.random() * 38,
      wobble: Math.random() * Math.PI * 2,
      layer,
      variant: Math.floor(Math.random() * 16),
    })
  }
  return flakes
}

export default function InfiniteMapScene() {
  const { t } = useLanguage()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const offRef = useRef<HTMLCanvasElement | null>(null)
  const keysRef = useRef<Set<string>>(new Set())
  const posRef = useRef({ x: 0, z: 400 })
  const animRef = useRef({ name: 'idledown', frameIdx: 0, accum: 0 })
  const facingRef = useRef(1)
  const rafRef = useRef(0)
  const lastTimeRef = useRef(0)
  const frameMapRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const blobWorldRef = useRef<BlobWorld | null>(null)
  const blobAtlasMtnRef = useRef<BlobAtlas | null>(null)
  const blobAtlasNormRef = useRef<BlobAtlas | null>(null)
  const blobAtlasNormX1Ref = useRef<BlobAtlas | null>(null)
  const blobAtlasNormX2Ref = useRef<BlobAtlas | null>(null)
  /** 与 map.html 一致：水用 007；可选 000–007 多帧动画 */
  const blobWaterFramesRef = useRef<(BlobAtlas | null)[]>([])
  const [ready, setReady] = useState(false)
  const [musicOn, setMusicOn] = useState(true)
  const [showTerrainLabels, setShowTerrainLabels] = useState(false)
  const [terrainSeaPct, setTerrainSeaPct] = useState(25)
  const [terrainMtnPct, setTerrainMtnPct] = useState(56)
  const [fxDimPct, setFxDimPct] = useState(12)
  const [fxVignettePct, setFxVignettePct] = useState(78)
  const [treePatchDensityPct, setTreePatchDensityPct] = useState(85)
  const [treeLoneDensityPct, setTreeLoneDensityPct] = useState(45)
  const [treeFeetDownSrcPx, setTreeFeetDownSrcPx] = useState(12)
  const [monsterCount, setMonsterCount] = useState(24)
  const [monsterAssetsReady, setMonsterAssetsReady] = useState(false)
  const fxDimRef = useRef(12)
  const fxVignetteRef = useRef(78)
  /** 成片林、独立树密度（0–100），供 rAF 循环读取 */
  const treePatchDensityRef = useRef(85)
  const treeLoneDensityRef = useRef(45)
  const treeFeetDownSrcPxRef = useRef(12)
  const monsterCountRef = useRef(24)
  const monsterImgsRef = useRef<HTMLImageElement[]>([])
  const monstersRef = useRef<MonsterInst[]>([])
  const showTerrainLabelsRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const gameWrapRef = useRef<HTMLDivElement>(null)
  const fallSnowRef = useRef<FallFlake[] | null>(null)
  const treeSnowImgRef = useRef<HTMLImageElement | null>(null)
  const [displayScale, setDisplayScale] = useState(1)

  useLayoutEffect(() => {
    const el = gameWrapRef.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const sx = r.width / W
      const sy = r.height / DISPLAY_H
      const s = Math.min(sx, sy)
      setDisplayScale(Number.isFinite(s) && s > 0 ? s : 1)
    }
    update()
    const ro = new ResizeObserver(() => update())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const audio = new Audio(BGM_URL)
    audio.loop = true
    audio.preload = 'auto'
    audioRef.current = audio
    return () => {
      audio.pause()
      audio.src = ''
      audioRef.current = null
    }
  }, [])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    if (musicOn) {
      void audio.play().catch(() => {})
    } else {
      audio.pause()
    }
  }, [musicOn])

  useEffect(() => {
    showTerrainLabelsRef.current = showTerrainLabels
  }, [showTerrainLabels])

  useEffect(() => {
    monsterCountRef.current = monsterCount
  }, [monsterCount])

  useEffect(() => {
    const cancel = loadMonsterImages((imgs) => {
      monsterImgsRef.current = imgs
      setMonsterAssetsReady(true)
    })
    return () => {
      cancel()
      monsterImgsRef.current = []
      monstersRef.current = []
      setMonsterAssetsReady(false)
    }
  }, [])

  const rebuildMonsterSwarm = useCallback(() => {
    const w = blobWorldRef.current
    const imgs = monsterImgsRef.current
    if (!w || imgs.length === 0) {
      monstersRef.current = []
      return
    }
    const n = Math.max(0, Math.min(MONSTER_COUNT_MAX, Math.floor(monsterCountRef.current)))
    monstersRef.current = createMonsterSwarm(n, w, posRef.current.x, posRef.current.z, imgs.length, TILE_WORLD)
  }, [])

  useEffect(() => {
    if (!ready || !monsterAssetsReady) return
    rebuildMonsterSwarm()
  }, [ready, monsterAssetsReady, monsterCount, rebuildMonsterSwarm])

  useEffect(() => {
    blobWorldRef.current = new BlobWorld('ronin-2026')
    return () => {
      blobWorldRef.current?.clearCache()
      blobWorldRef.current = null
    }
  }, [])

  useEffect(() => {
    const w = blobWorldRef.current
    if (!w) return
    w.setParams(terrainSeaPct / 100, terrainMtnPct / 100)
    w.clearCache()
  }, [terrainSeaPct, terrainMtnPct])

  /** 出生点若落在水或山上，挪到最近平地 */
  useEffect(() => {
    if (!ready) return
    const w = blobWorldRef.current
    if (!w) return
    const tix = Math.floor(posRef.current.x / TILE_WORLD)
    const tiz = Math.floor(posRef.current.z / TILE_WORLD)
    if (!isBlobTileWalkable(w, tix, tiz)) {
      const p =
        findWalkableTileCenter(w, tix, tiz, 240, TILE_WORLD) ??
        findWalkableTileCenter(w, 0, 0, 400, TILE_WORLD)
      if (p) {
        posRef.current.x = p.wx
        posRef.current.z = p.wz
      }
    }
  }, [ready])

  const handleRandomMap = useCallback(() => {
    const w = blobWorldRef.current
    if (!w) return
    const seed = `w${Math.random().toString(36).slice(2, 11)}${Date.now().toString(36)}`
    w.reseed(seed)
    w.setParams(terrainSeaPct / 100, terrainMtnPct / 100)
    const ox = Math.floor(posRef.current.x / TILE_WORLD)
    const oz = Math.floor(posRef.current.z / TILE_WORLD)
    const p =
      findWalkableTileCenter(w, ox, oz, 260, TILE_WORLD) ??
      findWalkableTileCenter(w, 0, 0, 400, TILE_WORLD)
    if (p) {
      posRef.current.x = p.wx
      posRef.current.z = p.wz
    }
    rebuildMonsterSwarm()
  }, [terrainSeaPct, terrainMtnPct, rebuildMonsterSwarm])

  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      treeSnowImgRef.current = img
    }
    img.src = TREE_SNOW_URL
    return () => {
      if (treeSnowImgRef.current === img) treeSnowImgRef.current = null
    }
  }, [])

  /** Blob 图集 3×24（与 map.html 同源） */
  useEffect(() => {
    let cancelled = false
    blobWaterFramesRef.current = BLOB_WATER_ANIM_FRAMES.map(() => null)

    const loadTo = (url: string, onOk: (a: BlobAtlas) => void) => {
      const img = new Image()
      img.onload = () => {
        if (cancelled) return
        const atlas = decodeBlobAtlasFromImage(img)
        if (atlas) onOk(atlas)
      }
      img.src = url
    }

    loadTo(BLOB_FRAME_MTN, (a) => {
      blobAtlasMtnRef.current = a
    })
    loadTo(BLOB_FRAME_NORM, (a) => {
      blobAtlasNormRef.current = a
    })
    loadTo(BLOB_FRAME_NORM_X1, (a) => {
      blobAtlasNormX1Ref.current = a
    })
    loadTo(BLOB_FRAME_NORM_X2, (a) => {
      blobAtlasNormX2Ref.current = a
    })

    BLOB_WATER_ANIM_FRAMES.forEach((url, idx) => {
      loadTo(url, (a) => {
        const next = blobWaterFramesRef.current.slice()
        next[idx] = a
        blobWaterFramesRef.current = next
      })
    })

    return () => {
      cancelled = true
      blobAtlasMtnRef.current = null
      blobAtlasNormRef.current = null
      blobAtlasNormX1Ref.current = null
      blobAtlasNormX2Ref.current = null
      blobWaterFramesRef.current = BLOB_WATER_ANIM_FRAMES.map(() => null)
    }
  }, [])

  /** 仅加载默认精灵表 map/TINA.png（与 topdown 同款切帧布局） */
  useEffect(() => {
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (cancelled) return
      const map = new Map<string, HTMLCanvasElement>()
      for (const key of Object.keys(REGIONS)) {
        const c = extractFrame(img, key)
        if (c) map.set(key, c)
      }
      frameMapRef.current = map
      setReady(true)
    }
    img.src = DEFAULT_CHAR_URL
    return () => {
      cancelled = true
      setReady(false)
    }
  }, [])

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight'].includes(e.code)) {
        e.preventDefault()
      }
      keysRef.current.add(e.code)
    }
    const ku = (e: KeyboardEvent) => {
      keysRef.current.delete(e.code)
    }
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
    }
  }, [])

  const gameLoop = useCallback(
    (now?: number) => {
      rafRef.current = requestAnimationFrame(gameLoop)
      const canvas = canvasRef.current
      if (!canvas || !ready) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = false

      let off = offRef.current
      if (!off || off.width !== W || off.height !== H) {
        off = document.createElement('canvas')
        off.width = W
        off.height = H
        offRef.current = off
      }
      const octx = off.getContext('2d')!
      const imageData = octx.createImageData(W, H)
      const data = imageData.data

      const t0 = typeof now === 'number' ? now : performance.now()
      const dt = lastTimeRef.current ? Math.min((t0 - lastTimeRef.current) / 1000, 1 / 15) : 1 / 60
      lastTimeRef.current = t0

      const keys = keysRef.current
      const pos = posRef.current
      const bwMove = blobWorldRef.current
      const w = keys.has('KeyW')
      const a = keys.has('KeyA')
      const s = keys.has('KeyS')
      const d = keys.has('KeyD')
      const shift = keys.has('ShiftLeft') || keys.has('ShiftRight')
      const speed = MOVE_SPEED * (shift ? RUN_MUL : 1)
      const walkPrefix = shift ? 'run' : 'walk'

      let nx = pos.x
      let nz = pos.z
      let nextAnim: string = animRef.current.name
      // 世界 Z 增大 = 向地平线前进；与 wz=camZ+dz 的透视一致
      if (w && !s) {
        nextAnim = `${walkPrefix}up`
        nz += speed
      } else if (s && !w) {
        nextAnim = `${walkPrefix}down`
        nz -= speed
      } else if (a && !d) {
        nextAnim = `${walkPrefix}L`
        facingRef.current = 1
        nx -= speed
      } else if (d && !a) {
        nextAnim = `${walkPrefix}L`
        facingRef.current = -1
        nx += speed
      } else {
        nextAnim = facingRef.current === 1 ? 'idleL' : 'idledown'
      }

      if (bwMove) {
        const tix = (x: number) => Math.floor(x / TILE_WORLD)
        const tiz = (z: number) => Math.floor(z / TILE_WORLD)
        if (isBlobTileWalkable(bwMove, tix(nx), tiz(nz))) {
          pos.x = nx
          pos.z = nz
        } else if (isBlobTileWalkable(bwMove, tix(nx), tiz(pos.z))) {
          pos.x = nx
        } else if (isBlobTileWalkable(bwMove, tix(pos.x), tiz(nz))) {
          pos.z = nz
        }
      } else {
        pos.x = nx
        pos.z = nz
      }

      let anim = animRef.current
      if (nextAnim !== anim.name) {
        anim = { name: nextAnim, frameIdx: 0, accum: 0 }
        animRef.current = anim
      }

      const camX = pos.x
      const camZ = pos.z - PLAYER_DZ

      const bwPre = blobWorldRef.current
      if (bwPre) {
        const vb = visibleGroundTileBounds(camX, camZ)
        if (vb) bwPre.preloadTileAABB(vb.tix0, vb.tix1, vb.tiz0, vb.tiz1)
        else
          bwPre.preloadAroundTile(Math.floor(camX / TILE_WORLD), Math.floor(camZ / TILE_WORLD), 48)
      }

      const tilePickCache = new Map<string, BlobTilePick>()
      const bw = blobWorldRef.current
      const mis = monsterImgsRef.current
      const mons = monstersRef.current
      if (bw && mis.length > 0 && mons.length > 0) {
        for (const m of mons) stepMonster(m, bw, dt, TILE_WORLD)
      }

      let p = 0
      for (let sy = 0; sy < H; sy++) {
        for (let sx = 0; sx < W; sx++) {
          if (sy < HORIZON) {
            const g = sy / Math.max(1, HORIZON - 1)
            const v = Math.floor(18 + g * 40)
            data[p++] = v
            data[p++] = v
            data[p++] = v
            data[p++] = 255
          } else if (sy < TERRAIN_SY_START) {
            const [hr, hg, hb] = farHazeRgb(sy)
            data[p++] = hr
            data[p++] = hg
            data[p++] = hb
            data[p++] = 255
          } else {
            const hit = screenToWorld(sx + 0.5, sy + 0.5, camX, camZ)
            if (!hit) {
              data[p++] = 12
              data[p++] = 12
              data[p++] = 12
              data[p++] = 255
              continue
            }
            const tix = Math.floor(hit.wx / TILE_WORLD)
            const tiz = Math.floor(hit.wz / TILE_WORLD)
            const tKey = `${tix},${tiz}`
            let pick = tilePickCache.get(tKey)
            if (bw && pick === undefined) {
              pick = bw.sampleTileIndex(tix, tiz)
              tilePickCache.set(tKey, pick)
            }
            const [cr, cg, cb] =
              bw && pick !== undefined
                ? sampleBlobTerrainRgbResolved(
                    blobAtlasMtnRef.current,
                    blobAtlasNormRef.current,
                    blobAtlasNormX1Ref.current,
                    blobAtlasNormX2Ref.current,
                    blobWaterFramesRef.current,
                    t0,
                    pick,
                    tix,
                    tiz,
                    hit.wx,
                    hit.wz,
                  )
                : mosaicRgb(tix, tiz)
            data[p++] = cr
            data[p++] = cg
            data[p++] = cb
            data[p++] = 255
          }
        }
      }

      octx.putImageData(imageData, 0, 0)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#080a0f'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(off, 0, CROP_TOP, W, DISPLAY_H, 0, 0, canvas.width, canvas.height)

      const treeImg = treeSnowImgRef.current
      let treesFront: { wx: number; wz: number }[] = []
      if (treeImg && treeImg.complete && treeImg.naturalWidth > 0 && bw) {
        let vbTrees = visibleGroundTileBounds(camX, camZ)
        if (!vbTrees) {
          const tcx = Math.floor(camX / TILE_WORLD)
          const tcz = Math.floor(camZ / TILE_WORLD)
          const sp = 26
          vbTrees = { tix0: tcx - sp, tix1: tcx + sp, tiz0: tcz - sp, tiz1: tcz + sp }
        }
        const treesBehind: { wx: number; wz: number }[] = []
        treesFront = []
        const pz = pos.z
        for (let tiz = vbTrees.tiz0; tiz <= vbTrees.tiz1; tiz++) {
          for (let tix = vbTrees.tix0; tix <= vbTrees.tix1; tix++) {
            if (!isBlobTileLandNotWater(bw, tix, tiz)) continue
            if (!shouldPlaceSnowTreeOnTile(tix, tiz, treePatchDensityRef.current, treeLoneDensityRef.current))
              continue
            const { wx, wz } = snowTreeFeetWorld(tix, tiz)
            if (wz > pz) treesBehind.push({ wx, wz })
            else treesFront.push({ wx, wz })
          }
        }
        treesBehind.sort((a, b) => b.wz - a.wz)
        treesFront.sort((a, b) => b.wz - a.wz)
        drawSnowTreesSorted(ctx, treeImg, camX, camZ, treesBehind, treeFeetDownSrcPxRef.current)
      }

      if (mis.length > 0 && mons.length > 0) {
        const pzM = pos.z
        const monstersBehind = mons.filter((m) => m.wz > pzM).sort((a, b) => b.wz - a.wz)
        drawMonstersSorted(ctx, mis, monstersBehind, camX, camZ)
      }

      const aDef = ANIMS.find((x) => x.name === anim.name) ?? ANIMS.find((x) => x.name === 'idledown')!
      const frameKey = aDef.frames[anim.frameIdx % aDef.frames.length]!
      const frameCanvas = frameMapRef.current.get(frameKey)

      const feet = worldToScreen(pos.x, pos.z, camX, camZ)
      if (frameCanvas && feet) {
        const { sx, sy } = feet
        const syDisp = sy - CROP_TOP
        const fw = frameCanvas.width
        const fh = frameCanvas.height
        const shadowTex = getShadowTexture()
        const shw = shadowTex.width * 0.85
        const shh = shadowTex.height * 0.85
        ctx.save()
        ctx.translate(sx, syDisp - 2)
        ctx.scale(0.85, 0.85)
        ctx.drawImage(shadowTex, -shw / 2, -shh / 2, shw, shh)
        ctx.restore()

        ctx.save()
        ctx.translate(sx, syDisp)
        ctx.scale(facingRef.current, 1)
        ctx.drawImage(frameCanvas, -fw / 2, -fh, fw, fh)
        ctx.restore()
      }

      if (treesFront.length > 0 && treeImg && treeImg.complete && treeImg.naturalWidth > 0) {
        drawSnowTreesSorted(ctx, treeImg, camX, camZ, treesFront, treeFeetDownSrcPxRef.current)
      }

      if (mis.length > 0 && mons.length > 0) {
        const pzM = pos.z
        const monstersFront = mons.filter((m) => m.wz <= pzM).sort((a, b) => b.wz - a.wz)
        drawMonstersSorted(ctx, mis, monstersFront, camX, camZ)
      }

      let flakes = fallSnowRef.current
      if (!flakes || flakes.length !== FALL_SNOW_COUNT) {
        flakes = createFallSnowFlakes()
        fallSnowRef.current = flakes
      }
      const tw = t0 * 0.0018
      for (const f of flakes) {
        f.y += f.vy * dt
        f.x += f.vx * dt + Math.sin(tw + f.wobble) * (f.layer === 0 ? 10 : f.layer === 1 ? 6 : 4) * dt
        const margin = f.layer === 2 ? 6 : f.layer === 1 ? 3 : 2
        if (f.y > DISPLAY_H + margin) {
          f.y = -margin - Math.random() * 60
          f.x = Math.random() * W
        }
        if (f.x > W + margin) f.x = -margin
        if (f.x < -margin) f.x = W + 2
      }
      ctx.save()
      ctx.imageSmoothingEnabled = false
      ctx.beginPath()
      ctx.rect(0, 0, W, DISPLAY_H)
      ctx.clip()
      for (const f of flakes) {
        const xi = Math.floor(f.x)
        const yi = Math.floor(f.y)
        const rgb = rgbForSnowFlake(f.layer, f.wobble)
        if (f.layer === 0) drawSnowFar(ctx, xi, yi, rgb)
        else if (f.layer === 1) drawSnowMid(ctx, xi, yi, rgb)
        else drawSnowNear(ctx, xi, yi, rgb, f.variant, W, DISPLAY_H)
      }
      ctx.restore()

      if (showTerrainLabelsRef.current) {
        const tcx = camX
        const tcz = camZ
        const span = 28
        const tix0 = Math.floor(tcx / TILE_WORLD) - span
        const tix1 = Math.floor(tcx / TILE_WORLD) + span
        const tiz0 = Math.floor(tcz / TILE_WORLD) - span
        const tiz1 = Math.floor(tcz / TILE_WORLD) + span
        ctx.save()
        ctx.imageSmoothingEnabled = false
        ctx.font = 'bold 9px monospace'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        for (let tiz = tiz0; tiz <= tiz1; tiz++) {
          for (let tix = tix0; tix <= tix1; tix++) {
            const wx = (tix + 0.5) * TILE_WORLD
            const wz = (tiz + 0.5) * TILE_WORLD
            const scr = worldToScreen(wx, wz, tcx, tcz)
            if (!scr) continue
            const y = scr.sy - CROP_TOP
            if (y < -10 || y > DISPLAY_H + 10) continue
            if (scr.sx < -30 || scr.sx > W + 30) continue
            const label = blobWorldRef.current
              ? describeBlobTerrain(blobWorldRef.current, tix, tiz)
              : '…'
            ctx.lineWidth = 3
            ctx.strokeStyle = 'rgba(0,0,0,0.92)'
            ctx.strokeText(label, scr.sx, y)
            ctx.fillStyle = 'rgba(255,255,100,0.95)'
            ctx.fillText(label, scr.sx, y)
          }
        }
        ctx.restore()
      }

      drawScenePostFx(ctx, W, DISPLAY_H, fxDimRef.current, fxVignetteRef.current)

      anim.accum += aDef.speed * dt
      while (anim.accum >= 1) {
        anim.accum -= 1
        anim.frameIdx += 1
        if (!aDef.loop && anim.frameIdx >= aDef.frames.length) {
          anim.frameIdx = aDef.frames.length - 1
          anim.accum = 0
          break
        }
        anim.frameIdx %= aDef.frames.length
      }
      animRef.current = anim
    },
    [ready],
  )

  useEffect(() => {
    lastTimeRef.current = 0
    rafRef.current = requestAnimationFrame(gameLoop)
    return () => cancelAnimationFrame(rafRef.current)
  }, [gameLoop])

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
      }}
    >
      <div style={{ flexShrink: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
        <Checkbox checked={musicOn} onChange={(e) => setMusicOn(e.target.checked)}>
          {t('infiniteMapMusic')}
        </Checkbox>
        <Checkbox checked={showTerrainLabels} onChange={(e) => setShowTerrainLabels(e.target.checked)}>
          {t('infiniteMapTerrainDebug')}
        </Checkbox>
        <Button type="default" size="small" onClick={handleRandomMap}>
          {t('infiniteMapRandomMap')}
        </Button>
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'nowrap',
          alignItems: 'flex-end',
          gap: 12,
          width: '100%',
          padding: '4px 0 2px',
        }}
      >
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapSeaLevel')} <span style={{ color: '#8b9dc3' }}>{(terrainSeaPct / 100).toFixed(2)}</span>
          </Text>
          <Slider
            min={TERRAIN_SEA_MIN}
            max={TERRAIN_SEA_MAX}
            value={terrainSeaPct}
            onChange={(v) => setTerrainSeaPct(v)}
            tooltip={{ formatter: (n) => (n !== undefined ? (n / 100).toFixed(2) : '') }}
          />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapMtnThreshold')}{' '}
            <span style={{ color: '#8b9dc3' }}>{(terrainMtnPct / 100).toFixed(2)}</span>
          </Text>
          <Slider
            min={TERRAIN_MTN_MIN}
            max={TERRAIN_MTN_MAX}
            value={terrainMtnPct}
            onChange={(v) => setTerrainMtnPct(v)}
            tooltip={{ formatter: (n) => (n !== undefined ? (n / 100).toFixed(2) : '') }}
          />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapFxDim')} <span style={{ color: '#8b9dc3' }}>{fxDimPct}%</span>
          </Text>
          <Slider
            min={0}
            max={100}
            value={fxDimPct}
            onChange={(v) => {
              fxDimRef.current = v
              setFxDimPct(v)
            }}
          />
        </div>
        <div style={{ flex: '1 1 0', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapFxVignette')} <span style={{ color: '#8b9dc3' }}>{fxVignettePct}%</span>
          </Text>
          <Slider
            min={0}
            max={100}
            value={fxVignettePct}
            onChange={(v) => {
              fxVignetteRef.current = v
              setFxVignettePct(v)
            }}
          />
        </div>
      </div>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'flex-end',
          gap: 12,
          width: '100%',
          padding: '2px 0 4px',
        }}
      >
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapTreePatchDensity')} <span style={{ color: '#8b9dc3' }}>{treePatchDensityPct}%</span>
          </Text>
          <Slider
            min={0}
            max={100}
            value={treePatchDensityPct}
            onChange={(v) => {
              treePatchDensityRef.current = v
              setTreePatchDensityPct(v)
            }}
          />
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapTreeLoneDensity')} <span style={{ color: '#8b9dc3' }}>{treeLoneDensityPct}%</span>
          </Text>
          <Slider
            min={0}
            max={100}
            value={treeLoneDensityPct}
            onChange={(v) => {
              treeLoneDensityRef.current = v
              setTreeLoneDensityPct(v)
            }}
          />
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapTreeFeetDown')}{' '}
            <span style={{ color: '#8b9dc3' }}>{treeFeetDownSrcPx}</span>
          </Text>
          <Slider
            min={TREE_FEET_DOWN_MIN}
            max={TREE_FEET_DOWN_MAX}
            value={treeFeetDownSrcPx}
            onChange={(v) => {
              treeFeetDownSrcPxRef.current = v
              setTreeFeetDownSrcPx(v)
            }}
          />
        </div>
        <div style={{ flex: '1 1 160px', minWidth: 0 }}>
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 4, lineHeight: 1.35 }}>
            {t('infiniteMapMonsterCount')}{' '}
            <span style={{ color: '#8b9dc3' }}>{monsterCount}</span>
          </Text>
          <Slider
            min={0}
            max={MONSTER_COUNT_MAX}
            value={monsterCount}
            onChange={(v) => {
              monsterCountRef.current = v
              setMonsterCount(v)
            }}
          />
        </div>
      </div>
      <div
        ref={gameWrapRef}
        style={{
          width: '100%',
          aspectRatio: '16 / 9',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0c12',
          borderRadius: 8,
          border: '1px solid #2a3040',
          overflow: 'hidden',
        }}
      >
        <canvas
          ref={canvasRef}
          width={W}
          height={DISPLAY_H}
          style={{
            display: 'block',
            width: W * displayScale,
            height: DISPLAY_H * displayScale,
            maxWidth: '100%',
            maxHeight: '100%',
            imageRendering: 'pixelated',
          }}
        />
      </div>
      <Text type="secondary" style={{ display: 'block', fontSize: 12, flexShrink: 0 }}>
        {t('infiniteMapKeys')}
      </Text>
    </div>
  )
}
