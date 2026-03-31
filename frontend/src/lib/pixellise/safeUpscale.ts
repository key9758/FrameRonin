/**
 * 网格检测阶段「放大后画布」总像素上限（过大易导致 WASM/内存失败或超时）。
 * 10M 时 2048² 只能 u=1；提到约 42M 后 2048² 可用至 u=3（约 37.7M），仍低于常见桌面浏览器可承受量级。
 */
export const PIXELLISE_MAX_SCALED_PIXELS = 42_000_000

/** 在不超过像素上限的前提下，允许的最大放大倍数（1～7） */
export function maxSafeUpscaleForImage(
  width: number,
  height: number,
  cap = PIXELLISE_MAX_SCALED_PIXELS,
): number {
  for (let u = 7; u >= 1; u--) {
    const sw = Math.round(width * u)
    const sh = Math.round(height * u)
    if (sw > 0 && sh > 0 && sw * sh <= cap) return u
  }
  return 1
}
