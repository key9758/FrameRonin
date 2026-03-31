import { isBlobTileLandNotWater, type BlobWorld } from './blobTerrain'
import { MONSTER_PUBLIC_FILENAMES } from 'virtual:infinite-map-monster-files'

export const MONSTER_COLS = 4
export const MONSTER_ROWS = 8

export type MonsterInst = {
  wx: number
  wz: number
  vx: number
  vz: number
  /** MONSTER_PUBLIC_FILENAMES 下标 */
  sheetIndex: number
  frame: number
  /** 秒，用于走路帧 */
  animT: number
  /** 秒，到时换方向 */
  repathIn: number
}

const EIGHT_DIRS: [number, number][] = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
]

/**
 * 行从 0 起：0下、1右下、2右、3右上、4上、5左上、6左、7左下（与素材第1–8行一致）
 */
export function velocityToMonsterRow(vx: number, vz: number): number {
  const s = Math.hypot(vx, vz)
  if (s < 0.08) return 0
  const nx = vx / s
  const nz = vz / s
  let best = 0
  let bestDot = -2
  for (let i = 0; i < EIGHT_DIRS.length; i++) {
    const [dx, dz] = EIGHT_DIRS[i]!
    const dot = nx * dx + nz * dz
    if (dot > bestDot) {
      bestDot = dot
      best = i
    }
  }
  return best
}

function randomEightDirSpeed(): { vx: number; vz: number } {
  const [dx, dz] = EIGHT_DIRS[Math.floor(Math.random() * 8)]!
  const sp = 1.4 + Math.random() * 1.8
  return { vx: dx * sp, vz: dz * sp }
}

function monsterUrls(): string[] {
  const base = `${import.meta.env.BASE_URL}map/monster/`
  return [...MONSTER_PUBLIC_FILENAMES].map((n) => base + n)
}

export function loadMonsterImages(onDone: (imgs: HTMLImageElement[]) => void): () => void {
  let cancelled = false
  const urls = monsterUrls()
  const imgs: HTMLImageElement[] = new Array(urls.length)
  let remaining = urls.length
  if (remaining === 0) {
    onDone([])
    return () => {}
  }
  const cleanups: (() => void)[] = []
  const tryFinish = () => {
    if (cancelled || remaining > 0) return
    onDone(imgs.filter((x) => x && x.naturalWidth > 0))
  }
  for (let i = 0; i < urls.length; i++) {
    const img = new Image()
    const idx = i
    const doneOne = () => {
      imgs[idx] = img
      remaining--
      tryFinish()
    }
    img.onload = doneOne
    img.onerror = doneOne
    img.src = urls[i]!
    cleanups.push(() => {
      img.onload = null
      img.onerror = null
      img.src = ''
    })
  }
  return () => {
    cancelled = true
    cleanups.forEach((f) => f())
  }
}

/**
 * 在陆地（平地+山地）上随机撒点；中心取角色附近世界格。
 */
export function createMonsterSwarm(
  count: number,
  world: BlobWorld,
  centerWx: number,
  centerWz: number,
  sheetCount: number,
  tileWorld: number,
): MonsterInst[] {
  if (count <= 0 || sheetCount <= 0) return []
  const out: MonsterInst[] = []
  const tcx = Math.floor(centerWx / tileWorld)
  const tcz = Math.floor(centerWz / tileWorld)
  let attempts = 0
  const maxAttempts = Math.max(count * 100, 400)
  while (out.length < count && attempts < maxAttempts) {
    attempts++
    const tix = tcx + Math.floor((Math.random() - 0.5) * 100)
    const tiz = tcz + Math.floor((Math.random() - 0.5) * 100)
    if (!isBlobTileLandNotWater(world, tix, tiz)) continue
    const { vx, vz } = randomEightDirSpeed()
    out.push({
      wx: (tix + 0.5) * tileWorld + (Math.random() - 0.5) * (tileWorld * 0.5),
      wz: (tiz + 0.5) * tileWorld + (Math.random() - 0.5) * (tileWorld * 0.5),
      vx,
      vz,
      sheetIndex: Math.floor(Math.random() * sheetCount),
      frame: Math.floor(Math.random() * 4),
      animT: Math.random() * 3,
      repathIn: 1.5 + Math.random() * 4,
    })
  }
  return out
}

export function stepMonster(
  m: MonsterInst,
  world: BlobWorld,
  dt: number,
  tileWorld: number,
): void {
  m.animT += dt
  m.repathIn -= dt
  if (m.repathIn <= 0) {
    m.repathIn = 2 + Math.random() * 5
    const { vx, vz } = randomEightDirSpeed()
    m.vx = vx
    m.vz = vz
  }
  const frameDur = 0.125
  if (m.animT >= frameDur) {
    const adv = Math.floor(m.animT / frameDur)
    m.animT -= adv * frameDur
    m.frame = (m.frame + adv) % MONSTER_COLS
  }

  const nx = m.wx + m.vx * dt
  const nz = m.wz + m.vz * dt
  const tix = Math.floor(nx / tileWorld)
  const tiz = Math.floor(nz / tileWorld)
  if (!isBlobTileLandNotWater(world, tix, tiz)) {
    m.vx *= -1
    m.vz *= -1
    m.repathIn = 0.4 + Math.random() * 0.6
    return
  }
  m.wx = nx
  m.wz = nz
}
