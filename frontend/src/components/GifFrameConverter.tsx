import { useEffect, useState } from 'react'
import { Button, InputNumber, message, Slider, Space, Tabs, Typography, Upload } from 'antd'
import { CaretLeftOutlined, CaretRightOutlined, DownloadOutlined, FileImageOutlined, PictureOutlined, MergeCellsOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import { parseGIF, decompressFrames } from 'gifuct-js'
// @ts-expect-error gifenc has no types
import { GIFEncoder, quantize, applyPalette } from 'gifenc'
import JSZip from 'jszip'
import { useLanguage } from '../i18n/context'
import CropPreview from './CropPreview'
import StashableImage from './StashableImage'
import StashDropZone from './StashDropZone'

const { Dragger } = Upload
const { Text } = Typography

const GIF_ACCEPT = '.gif'
const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']

function compositeFrame(
  prevBuf: Uint8ClampedArray,
  frame: { patch: Uint8ClampedArray; dims: { top: number; left: number; width: number; height: number }; disposalType?: number },
  width: number,
  height: number
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(prevBuf)
  const { patch, dims, disposalType = 1 } = frame
  const { top, left, width: pw, height: ph } = dims

  if (disposalType === 2) {
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
      buf[i + 3] = 0
    }
  }

  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const idx = (py * pw + px) * 4
      const a = patch[idx + 3]
      const outY = top + py
      const outX = left + px
      if (outY >= 0 && outY < height && outX >= 0 && outX < width) {
        const outIdx = (outY * width + outX) * 4
        if (a === 0) {
          buf[outIdx] = 0
          buf[outIdx + 1] = 0
          buf[outIdx + 2] = 0
          buf[outIdx + 3] = 0
        } else {
          buf[outIdx] = patch[idx]
          buf[outIdx + 1] = patch[idx + 1]
          buf[outIdx + 2] = patch[idx + 2]
          buf[outIdx + 3] = a
        }
      }
    }
  }
  return buf
}

export default function GifFrameConverter() {
  const { t } = useLanguage()
  const [activeTab, setActiveTab] = useState<'gif2frames' | 'frames2gif' | 'images2single'>('gif2frames')
  const [gifFile, setGifFile] = useState<File | null>(null)
  const [gifPreviewUrl, setGifPreviewUrl] = useState<string | null>(null)
  const [frameFiles, setFrameFiles] = useState<File[]>([])
  const [frameInputUrls, setFrameInputUrls] = useState<string[]>([])
  const [frameDelay, setFrameDelay] = useState(100)
  const [loading, setLoading] = useState(false)
  const [framesZipUrl, setFramesZipUrl] = useState<string | null>(null)
  const [extractedFrameUrls, setExtractedFrameUrls] = useState<string[]>([])
  const [gifUrl, setGifUrl] = useState<string | null>(null)

  const [combineFiles, setCombineFiles] = useState<File[]>([])
  const [combineInputUrls, setCombineInputUrls] = useState<string[]>([])
  const [combineCols, setCombineCols] = useState(4)
  const [combinedUrl, setCombinedUrl] = useState<string | null>(null)
  const [cropTop, setCropTop] = useState(0)
  const [cropBottom, setCropBottom] = useState(0)
  const [cropLeft, setCropLeft] = useState(0)
  const [cropRight, setCropRight] = useState(0)
  const [cropPreviewIndex, setCropPreviewIndex] = useState(0)
  const [firstImageSize, setFirstImageSize] = useState<{ w: number; h: number } | null>(null)

  const revokeExtractedPreviews = () => {
    setExtractedFrameUrls((urls) => {
      urls.forEach(URL.revokeObjectURL)
      return []
    })
  }

  useEffect(() => {
    if (gifFile) {
      const url = URL.createObjectURL(gifFile)
      setGifPreviewUrl(url)
      return () => URL.revokeObjectURL(url)
    }
    setGifPreviewUrl(null)
  }, [gifFile])

  useEffect(() => () => revokeExtractedPreviews(), [])

  useEffect(() => {
    const urls = frameFiles.map((f) => URL.createObjectURL(f))
    setFrameInputUrls(urls)
    return () => urls.forEach(URL.revokeObjectURL)
  }, [frameFiles])

  useEffect(() => {
    const urls = combineFiles.map((f) => URL.createObjectURL(f))
    setCombineInputUrls(urls)
    return () => urls.forEach(URL.revokeObjectURL)
  }, [combineFiles])

  useEffect(() => {
    if (combineFiles.length === 0) {
      setFirstImageSize(null)
      setCropPreviewIndex(0)
    } else {
      setCropPreviewIndex((i) => Math.min(i, combineFiles.length - 1))
    }
  }, [combineFiles.length])

  const runImagesToSingle = async () => {
    if (combineFiles.length === 0) return
    setLoading(true)
    setCombinedUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    try {
      const imgs: HTMLImageElement[] = []
      const top = Math.max(0, cropTop)
      const bottom = Math.max(0, cropBottom)
      const left = Math.max(0, cropLeft)
      const right = Math.max(0, cropRight)
      let maxW = 0
      let maxH = 0
      for (const f of combineFiles) {
        const url = URL.createObjectURL(f)
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = () => rej(new Error('load'))
          i.src = url
        })
        URL.revokeObjectURL(url)
        const sw = Math.max(1, img.naturalWidth - left - right)
        const sh = Math.max(1, img.naturalHeight - top - bottom)
        maxW = Math.max(maxW, sw)
        maxH = Math.max(maxH, sh)
        imgs.push(img)
      }
      const cols = Math.max(1, Math.floor(combineCols))
      const rows = Math.ceil(imgs.length / cols)
      const outW = cols * maxW
      const outH = rows * maxH
      const canvas = document.createElement('canvas')
      canvas.width = outW
      canvas.height = outH
      const ctx = canvas.getContext('2d')!
      // 不填充背景，保持透明
      for (let i = 0; i < imgs.length; i++) {
        const img = imgs[i]!
        const sw = Math.max(1, img.naturalWidth - left - right)
        const sh = Math.max(1, img.naturalHeight - top - bottom)
        const r = Math.floor(i / cols)
        const c = i % cols
        const dx = c * maxW + (maxW - sw) / 2
        const dy = r * maxH + (maxH - sh) / 2
        ctx.drawImage(img, left, top, sw, sh, dx, dy, sw, sh)
      }
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png')
      })
      setCombinedUrl(URL.createObjectURL(blob))
      message.success(t('imagesToSingleSuccess'))
    } catch (e) {
      message.error(t('imagesToSingleFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const downloadCombined = () => {
    if (!combinedUrl) return
    const a = document.createElement('a')
    a.href = combinedUrl
    a.download = 'combined.png'
    a.click()
  }

  const runGifToFrames = async () => {
    if (!gifFile) return
    setLoading(true)
    revokeExtractedPreviews()
    setFramesZipUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    try {
      const buf = await gifFile.arrayBuffer()
      const gif = parseGIF(buf)
      const frames = decompressFrames(gif, true)
      const w = gif.lsd.width
      const h = gif.lsd.height

      let prevBuf = new Uint8ClampedArray(w * h * 4)
      prevBuf.fill(0)

      const zip = new JSZip()
      const previewUrls: string[] = []
      const maxPreview = 24
      for (let i = 0; i < frames.length; i++) {
        const f = frames[i] as { patch: Uint8ClampedArray; dims: { top: number; left: number; width: number; height: number }; disposalType?: number }
        prevBuf = compositeFrame(prevBuf, f, w, h) as typeof prevBuf
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        const imgData = ctx.createImageData(w, h)
        imgData.data.set(prevBuf)
        ctx.putImageData(imgData, 0, 0)
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas'))), 'image/png')
        })
        zip.file(`frame_${String(i).padStart(3, '0')}.png`, blob)
        if (previewUrls.length < maxPreview) {
          previewUrls.push(URL.createObjectURL(blob))
        }
      }

      setExtractedFrameUrls(previewUrls)
      const zipBlob = await zip.generateAsync({ type: 'blob' })
      setFramesZipUrl(URL.createObjectURL(zipBlob))
      message.success(t('gifExtractSuccess', { n: frames.length }))
    } catch (e) {
      message.error(t('gifExtractFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const runFramesToGif = async () => {
    if (frameFiles.length === 0) return
    setLoading(true)
    setGifUrl((old) => {
      if (old) URL.revokeObjectURL(old)
      return null
    })
    try {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const imgs: ImageData[] = []
      let w = 0
      let h = 0
      for (const f of frameFiles) {
        const blob = await f.arrayBuffer()
        const url = URL.createObjectURL(new Blob([blob]))
        const img = await new Promise<HTMLImageElement>((res, rej) => {
          const i = new Image()
          i.onload = () => res(i)
          i.onerror = () => rej(new Error('load'))
          i.src = url
        })
        URL.revokeObjectURL(url)
        if (imgs.length === 0) {
          w = img.width
          h = img.height
        }
        canvas.width = w
        canvas.height = h
        ctx.clearRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        imgs.push(ctx.getImageData(0, 0, w, h))
      }

      const gif = GIFEncoder()
      for (let i = 0; i < imgs.length; i++) {
        const { data, width, height } = imgs[i]
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
            if (data[j + 3] < 128) {
              finalIndex[j / 4] = 0
            } else {
              finalIndex[j / 4] = index[j / 4]! + 1
            }
          }
          transparentIndex = 0
        }
        gif.writeFrame(finalIndex, width, height, {
          palette: finalPalette,
          delay: frameDelay,
          transparent: true,
          transparentIndex,
        })
      }
      gif.finish()
      const bytes = gif.bytes()
      const blob = new Blob([bytes], { type: 'image/gif' })
      setGifUrl(URL.createObjectURL(blob))
      message.success(t('gifEncodeSuccess'))
    } catch (e) {
      message.error(t('gifEncodeFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
    }
  }

  const downloadZip = () => {
    if (!framesZipUrl) return
    const a = document.createElement('a')
    a.href = framesZipUrl
    a.download = (gifFile?.name?.replace(/\.gif$/i, '') || 'frames') + '_frames.zip'
    a.click()
  }

  const downloadGif = () => {
    if (!gifUrl) return
    const a = document.createElement('a')
    a.href = gifUrl
    a.download = 'output.gif'
    a.click()
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%', paddingTop: 8 }}>
      <Tabs
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'gif2frames' | 'frames2gif' | 'images2single')}
        items={[
          {
            key: 'gif2frames',
            label: (
              <span>
                <FileImageOutlined /> {t('gifToFrames')}
              </span>
            ),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('gifToFramesHint')}</Text>
                <StashDropZone
                  onStashDrop={(f) => {
                    setGifFile(f)
                    revokeExtractedPreviews()
                    setFramesZipUrl((old) => {
                      if (old) URL.revokeObjectURL(old)
                      return null
                    })
                  }}
                >
                  <Dragger
                    accept={GIF_ACCEPT}
                    maxCount={1}
                    fileList={gifFile ? [{ uid: '1', name: gifFile.name } as UploadFile] : []}
                    beforeUpload={(f) => {
                      setGifFile(f)
                      revokeExtractedPreviews()
                      setFramesZipUrl((old) => {
                        if (old) URL.revokeObjectURL(old)
                        return null
                      })
                      return false
                    }}
                    onRemove={() => setGifFile(null)}
                  >
                    <p className="ant-upload-text">{t('gifUploadHint')}</p>
                  </Dragger>
                </StashDropZone>
                {gifFile && gifPreviewUrl && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>{t('imgOriginalPreview')}</Text>
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
                        src={gifPreviewUrl}
                        alt=""
                        style={{ maxWidth: 320, maxHeight: 240, display: 'block' }}
                      />
                    </div>
                  </>
                )}
                <Space style={{ marginTop: 16 }}>
                  <Button type="primary" loading={loading} onClick={runGifToFrames} disabled={!gifFile}>
                    {t('gifToFrames')}
                  </Button>
                  {framesZipUrl && (
                    <Button icon={<DownloadOutlined />} onClick={downloadZip}>
                      {t('gifDownloadFrames')}
                    </Button>
                  )}
                </Space>
                {extractedFrameUrls.length > 0 && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 24, marginBottom: 8 }}>{t('imgPreview')}</Text>
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
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 320, overflow: 'auto' }}>
                        {extractedFrameUrls.map((url, i) => (
                          <StashableImage
                            key={i}
                            src={url}
                            alt={`${t('frame')} ${i + 1}`}
                            style={{ maxWidth: 120, maxHeight: 120, imageRendering: 'pixelated', border: '1px solid rgba(0,0,0,0.1)' }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </>
            ),
          },
          {
            key: 'frames2gif',
            label: (
              <span>
                <PictureOutlined /> {t('framesToGif')}
              </span>
            ),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('framesToGifHint')}</Text>
                <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('gifFrameDelay')}:</Text>
                <Slider min={20} max={500} value={frameDelay} onChange={setFrameDelay} style={{ maxWidth: 200, marginBottom: 16 }} />
                <Text type="secondary" style={{ fontSize: 12 }}>{frameDelay} ms</Text>
                <StashDropZone
                  onStashDrop={(f) => setFrameFiles((prev) => [...prev, f])}
                >
                  <Dragger
                    accept={IMAGE_ACCEPT.join(',')}
                    multiple
                    fileList={frameFiles.map((f, i) => ({ uid: String(i), name: f.name } as UploadFile))}
                    beforeUpload={(f) => {
                      setFrameFiles((prev) => [...prev, f])
                      return false
                    }}
                    onRemove={(file) => {
                      const idx = frameFiles.findIndex((_, i) => String(i) === file.uid)
                      if (idx >= 0) setFrameFiles((prev) => prev.filter((_, i) => i !== idx))
                    }}
                    style={{ marginTop: 16 }}
                  >
                    <p className="ant-upload-text">{t('framesUploadHint')}</p>
                  </Dragger>
                </StashDropZone>
                {frameInputUrls.length > 0 && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>{t('imgOriginalPreview')}</Text>
                    <div
                      style={{
                        padding: 16,
                        background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
                        borderRadius: 8,
                        border: '1px solid #9a8b78',
                        display: 'inline-block',
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 200, overflow: 'auto' }}>
                        {frameInputUrls.map((url, i) => (
                          <StashableImage
                            key={i}
                            src={url}
                            alt={`${t('frame')} ${i + 1}`}
                            style={{ maxWidth: 80, maxHeight: 80, objectFit: 'contain', border: '1px solid rgba(0,0,0,0.1)' }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <Space style={{ marginTop: 16 }}>
                  <Button type="primary" loading={loading} onClick={runFramesToGif} disabled={frameFiles.length === 0}>
                    {t('framesToGif')}
                  </Button>
                  {gifUrl && (
                    <Button icon={<DownloadOutlined />} onClick={downloadGif}>
                      {t('gifDownloadGif')}
                    </Button>
                  )}
                </Space>
                {gifUrl && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 24, marginBottom: 8 }}>{t('imgPreview')}</Text>
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
                        src={gifUrl}
                        alt={t('imgPreview')}
                        style={{ maxWidth: '100%', maxHeight: 320, display: 'block', imageRendering: 'auto' }}
                      />
                    </div>
                  </>
                )}
              </>
            ),
          },
          {
            key: 'images2single',
            label: (
              <span>
                <MergeCellsOutlined /> {t('imagesToSingle')}
              </span>
            ),
            children: (
              <>
                <Text type="secondary" style={{ display: 'block', marginBottom: 12 }}>{t('imagesToSingleHint')}</Text>
                <Space wrap align="center" style={{ marginBottom: 12 }}>
                  <Text type="secondary">{t('imagesToSingleCols')}:</Text>
                  <InputNumber min={1} max={64} value={combineCols} onChange={(v) => setCombineCols(v ?? 4)} style={{ width: 72 }} />
                </Space>
                {combineFiles.length > 0 && combineInputUrls.length > 0 && (
                  <div style={{ marginBottom: 16 }}>
                    <Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>{t('imagesToSingleCropHint')}</Text>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Button
                            type="text"
                            size="small"
                            icon={<CaretLeftOutlined />}
                            disabled={combineFiles.length <= 1 || cropPreviewIndex <= 0}
                            onClick={() => setCropPreviewIndex((i) => Math.max(0, i - 1))}
                          />
                          <CropPreview
                            key={cropPreviewIndex}
                            imageUrl={combineInputUrls[cropPreviewIndex]!}
                            cropTop={cropTop}
                            cropBottom={cropBottom}
                            cropLeft={cropLeft}
                            cropRight={cropRight}
                            onChange={({ top, bottom, left, right }) => {
                              setCropTop(top)
                              setCropBottom(bottom)
                              setCropLeft(left)
                              setCropRight(right)
                            }}
                            onImageSize={cropPreviewIndex === 0 ? (w, h) => setFirstImageSize({ w, h }) : undefined}
                            loadingText={t('cropPreviewLoading')}
                          />
                          <Button
                            type="text"
                            size="small"
                            icon={<CaretRightOutlined />}
                            disabled={combineFiles.length <= 1 || cropPreviewIndex >= combineFiles.length - 1}
                            onClick={() => setCropPreviewIndex((i) => Math.min(combineFiles.length - 1, i + 1))}
                          />
                        </div>
                        {combineFiles.length > 1 && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t('imagesToSingleCropPreviewN', { current: cropPreviewIndex + 1, total: combineFiles.length })}
                          </Text>
                        )}
                      </div>
                      <div style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <Space wrap align="center">
                          <InputNumber min={0} value={cropTop} onChange={(v) => setCropTop(v ?? 0)} style={{ width: 64 }} addonBefore={t('batchCropTop')} />
                          <InputNumber min={0} value={cropBottom} onChange={(v) => setCropBottom(v ?? 0)} style={{ width: 64 }} addonBefore={t('batchCropBottom')} />
                          <InputNumber min={0} value={cropLeft} onChange={(v) => setCropLeft(v ?? 0)} style={{ width: 64 }} addonBefore={t('batchCropLeft')} />
                          <InputNumber min={0} value={cropRight} onChange={(v) => setCropRight(v ?? 0)} style={{ width: 64 }} addonBefore={t('batchCropRight')} />
                        </Space>
                        {firstImageSize && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {t('imagesToSingleCropRemaining', {
                              w: Math.max(0, firstImageSize.w - cropLeft - cropRight),
                              h: Math.max(0, firstImageSize.h - cropTop - cropBottom),
                            })}
                          </Text>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                <StashDropZone onStashDrop={(f) => setCombineFiles((prev) => [...prev, f])}>
                  <Dragger
                    accept={IMAGE_ACCEPT.join(',')}
                    multiple
                    fileList={combineFiles.map((f, i) => ({ uid: `c-${i}`, name: f.name } as UploadFile))}
                    beforeUpload={(f) => {
                      setCombineFiles((prev) => [...prev, f])
                      return false
                    }}
                    onRemove={(file) => {
                      const idx = combineFiles.findIndex((_, i) => `c-${i}` === file.uid)
                      if (idx >= 0) setCombineFiles((prev) => prev.filter((_, i) => i !== idx))
                    }}
                  >
                    <p className="ant-upload-text">{t('framesUploadHint')}</p>
                  </Dragger>
                </StashDropZone>
                {combineInputUrls.length > 0 && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>{t('imgOriginalPreview')}</Text>
                    <div
                      style={{
                        padding: 16,
                        background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
                        borderRadius: 8,
                        border: '1px solid #9a8b78',
                        display: 'inline-block',
                      }}
                    >
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, maxHeight: 200, overflow: 'auto' }}>
                        {combineInputUrls.map((url, i) => (
                          <StashableImage
                            key={i}
                            src={url}
                            alt={`${t('frame')} ${i + 1}`}
                            style={{ maxWidth: 80, maxHeight: 80, objectFit: 'contain', border: '1px solid rgba(0,0,0,0.1)' }}
                          />
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <Space style={{ marginTop: 16 }}>
                  <Button type="primary" loading={loading} onClick={runImagesToSingle} disabled={combineFiles.length === 0}>
                    {loading ? t('imagesToSingleCombining') : t('imagesToSingleCombine')}
                  </Button>
                  {combinedUrl && (
                    <Button icon={<DownloadOutlined />} onClick={downloadCombined}>
                      {t('imagesToSingleDownload')}
                    </Button>
                  )}
                </Space>
                {combinedUrl && (
                  <>
                    <Text strong style={{ display: 'block', marginTop: 24, marginBottom: 8 }}>{t('imgPreview')}</Text>
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
                        src={combinedUrl}
                        alt={t('imgPreview')}
                        style={{ maxWidth: '100%', maxHeight: 400, display: 'block', imageRendering: 'pixelated' }}
                      />
                    </div>
                  </>
                )}
              </>
            ),
          },
        ]}
      />
    </Space>
  )
}
