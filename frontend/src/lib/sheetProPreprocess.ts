/**
 * RoninPro 单图调整 Pro：整图 / 透明拆分前的可选预处理链（与自定义流程节点语义对齐）
 */
import {
  applyChromaKey,
  applyChromaKeyContiguousFromTopLeft,
  cropImageBlob,
  getTopLeftPixelColor,
  resizeImageToBlobNearestNeighborPS,
} from '../components/ParamsStep/utils'
import { removeGeminiWatermarkFromBlob } from './geminiWatermark'
import { wfPadExpand } from './roninProWorkflowGridOps'

export type SheetPreMatteMode = 'none' | 'contiguous' | 'global'

export type SheetProPreprocessOptions = {
  watermark: boolean
  cropTop: number
  cropBottom: number
  cropLeft: number
  cropRight: number
  padTop: number
  padRight: number
  padBottom: number
  padLeft: number
  resizeEnabled: boolean
  resizeW: number
  resizeH: number
  resizeKeepAspect: boolean
  matteMode: SheetPreMatteMode
  matteTolerance: number
  matteFeather: number
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result as string)
    r.onerror = () => reject(new Error('ERR_READ'))
    r.readAsDataURL(blob)
  })
}

export function sheetProPreprocessIsNoop(o: SheetProPreprocessOptions): boolean {
  if (o.watermark) return false
  if (o.resizeEnabled) return false
  if (o.matteMode !== 'none') return false
  if (o.cropTop + o.cropBottom + o.cropLeft + o.cropRight > 0) return false
  if (o.padTop + o.padRight + o.padBottom + o.padLeft > 0) return false
  return true
}

/**
 * 顺序：去水印 → 向内裁切 → 透明扩边 → 硬缩放（最近邻）→ 去背景（左上取色）
 */
export async function applySheetProPreprocess(
  blob: Blob,
  o: SheetProPreprocessOptions
): Promise<Blob> {
  if (sheetProPreprocessIsNoop(o)) return blob
  let b = blob
  if (o.watermark) {
    b = await removeGeminiWatermarkFromBlob(b)
  }
  const ct = Math.max(0, Math.round(o.cropTop))
  const cb = Math.max(0, Math.round(o.cropBottom))
  const cl = Math.max(0, Math.round(o.cropLeft))
  const cr = Math.max(0, Math.round(o.cropRight))
  if (ct + cb + cl + cr > 0) {
    b = await cropImageBlob(b, { top: ct, bottom: cb, left: cl, right: cr })
  }
  const pt = Math.max(0, Math.round(o.padTop))
  const pr = Math.max(0, Math.round(o.padRight))
  const pb = Math.max(0, Math.round(o.padBottom))
  const pl = Math.max(0, Math.round(o.padLeft))
  if (pt + pr + pb + pl > 0) {
    b = await wfPadExpand(b, pt, pr, pb, pl)
  }
  if (o.resizeEnabled) {
    const rw = Math.max(1, Math.round(o.resizeW))
    const rh = Math.max(1, Math.round(o.resizeH))
    b = await resizeImageToBlobNearestNeighborPS(b, rw, rh, o.resizeKeepAspect)
  }
  if (o.matteMode === 'contiguous' || o.matteMode === 'global') {
    const { r, g, b: bb } = await getTopLeftPixelColor(b)
    const dataUrl = await blobToDataUrl(b)
    const tol = Math.max(0, o.matteTolerance)
    const fea = Math.max(0, o.matteFeather)
    const res =
      o.matteMode === 'contiguous'
        ? await applyChromaKeyContiguousFromTopLeft(dataUrl, r, g, bb, tol, fea)
        : await applyChromaKey(dataUrl, r, g, bb, tol, fea)
    b = res.blob
  }
  return b
}
