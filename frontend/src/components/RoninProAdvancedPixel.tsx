import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Checkbox,
  Divider,
  InputNumber,
  message,
  Radio,
  Slider,
  Space,
  Typography,
  Upload,
} from 'antd'
import { DownloadOutlined, PlayCircleOutlined, PictureOutlined } from '@ant-design/icons'
import type { UploadFile } from 'antd'
import JSZip from 'jszip'
import { useLanguage } from '../i18n/context'
import { expandFramesWithOpticalMidpoints } from '../lib/opticalFlowInterpolate'
import type { OpticalFlowQuality } from '../lib/opticalFlowInterpolate'
import { composeSpriteSheetGrid, splitSpriteSheetGrid } from '../lib/spriteGridDuplicate'
import StashableImage from './StashableImage'
import StashDropZone from './StashDropZone'

const { Dragger } = Upload
const { Text, Title } = Typography

const IMAGE_ACCEPT = ['.png', '.jpg', '.jpeg', '.webp']

type InputMode = 'files' | 'sheet'

function sortFilesByName(files: File[]): File[] {
  return [...files].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
  )
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image load failed'))
    }
    img.src = url
  })
}

/**
 * RoninPro — 高级像素处理（光流补帧：多文件或精灵表切分输入；ZIP / 精灵表输出）
 */
export default function RoninProAdvancedPixel() {
  const { t } = useLanguage()
  const [inputMode, setInputMode] = useState<InputMode>('files')
  const [fileList, setFileList] = useState<UploadFile[]>([])
  const [spriteSheetFile, setSpriteSheetFile] = useState<File | null>(null)
  const [spritePreviewUrl, setSpritePreviewUrl] = useState<string | null>(null)
  const [firstFilePreviewUrl, setFirstFilePreviewUrl] = useState<string | null>(null)
  const [spriteCols, setSpriteCols] = useState(4)
  const [spriteRows, setSpriteRows] = useState(1)

  const [loadedImages, setLoadedImages] = useState<(HTMLImageElement | HTMLCanvasElement)[]>([])

  const [alpha, setAlpha] = useState(0.5)
  const [nearest, setNearest] = useState(false)
  const [bidirectional, setBidirectional] = useState(true)
  const [smoothFlow, setSmoothFlow] = useState(true)
  const [quality, setQuality] = useState<OpticalFlowQuality>('balanced')
  const [maxMotionRel, setMaxMotionRel] = useState(0.35)

  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [resultUrls, setResultUrls] = useState<string[]>([])
  const [resultCanvases, setResultCanvases] = useState<HTMLCanvasElement[]>([])
  const [sheetOutCols, setSheetOutCols] = useState(1)

  const frameFiles = useMemo(
    () =>
      sortFilesByName(
        fileList.map((f) => f.originFileObj as File | undefined).filter((x): x is File => Boolean(x)),
      ),
    [fileList],
  )

  useEffect(() => {
    if (!spriteSheetFile) {
      setSpritePreviewUrl(null)
      return
    }
    const u = URL.createObjectURL(spriteSheetFile)
    setSpritePreviewUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [spriteSheetFile])

  useEffect(() => {
    if (inputMode !== 'files' || frameFiles.length === 0) {
      setFirstFilePreviewUrl(null)
      return
    }
    const u = URL.createObjectURL(frameFiles[0]!)
    setFirstFilePreviewUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [inputMode, frameFiles])

  useEffect(() => {
    return () => {
      resultUrls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [resultUrls])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (inputMode === 'files') {
        if (frameFiles.length === 0) {
          if (!cancelled) setLoadedImages([])
          return
        }
        try {
          const imgs: HTMLImageElement[] = []
          for (const f of frameFiles) {
            imgs.push(await loadImageFromFile(f))
          }
          if (!cancelled) setLoadedImages(imgs)
        } catch {
          if (!cancelled) {
            setLoadedImages([])
            message.error(t('roninProFlowFramesLoadFailed'))
          }
        }
        return
      }

      if (!spriteSheetFile) {
        if (!cancelled) setLoadedImages([])
        return
      }
      try {
        const img = await loadImageFromFile(spriteSheetFile)
        const c = Math.max(1, Math.min(64, Math.floor(spriteCols)))
        const r = Math.max(1, Math.min(64, Math.floor(spriteRows)))
        const cells = splitSpriteSheetGrid(img, c, r)
        if (!cancelled) setLoadedImages(cells)
      } catch {
        if (!cancelled) {
          setLoadedImages([])
          message.error(t('roninProFlowFramesLoadFailed'))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [inputMode, frameFiles, spriteSheetFile, spriteCols, spriteRows, t])

  const clearResults = () => {
    resultUrls.forEach(URL.revokeObjectURL)
    setResultUrls([])
    setResultCanvases([])
    setProgress(null)
  }

  const runInterpolate = async () => {
    if (loadedImages.length < 2) {
      message.warning(t('roninProFlowFramesNeedTwo'))
      return
    }
    clearResults()
    setLoading(true)
    setProgress({ done: 0, total: loadedImages.length - 1 })
    const key = 'opencv-flow'
    try {
      message.loading({ content: t('roninProFlowOpenCvLoading'), key, duration: 0 })
      const canvases = await expandFramesWithOpticalMidpoints(
        loadedImages,
        {
          alpha,
          nearestNeighbor: nearest,
          bidirectional,
          smoothFlow,
          quality,
          maxMotionRelative: maxMotionRel,
        },
        (done, total) => setProgress({ done, total }),
      )
      message.destroy(key)

      setResultCanvases(canvases)
      const n = canvases.length
      setSheetOutCols(Math.max(1, Math.ceil(Math.sqrt(n))))

      const urls: string[] = []
      for (let i = 0; i < canvases.length; i++) {
        const c = canvases[i]!
        const blob = await new Promise<Blob>((resolve, reject) => {
          c.toBlob((b) => (b ? resolve(b) : reject(new Error('blob'))), 'image/png')
        })
        urls.push(URL.createObjectURL(blob))
      }
      setResultUrls(urls)
      message.success(t('roninProFlowDone', { out: canvases.length, src: loadedImages.length }))
    } catch (e) {
      message.destroy(key)
      message.error(t('roninProFlowFailed') + ': ' + String(e))
    } finally {
      setLoading(false)
      setProgress(null)
    }
  }

  const downloadZip = async () => {
    if (resultUrls.length === 0) return
    try {
      const zip = new JSZip()
      for (let i = 0; i < resultUrls.length; i++) {
        const res = await fetch(resultUrls[i]!)
        const buf = await res.arrayBuffer()
        const name = `frame_${String(i + 1).padStart(3, '0')}.png`
        zip.file(name, buf)
      }
      const blob = await zip.generateAsync({ type: 'blob' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = 'roninpro_flow_frames.zip'
      a.click()
      URL.revokeObjectURL(a.href)
      message.success(t('roninProFlowZipOk'))
    } catch (e) {
      message.error(t('roninProFlowZipFailed') + ': ' + String(e))
    }
  }

  const downloadSpriteSheet = () => {
    if (resultCanvases.length === 0) return
    try {
      const cols = Math.max(1, Math.min(resultCanvases.length, Math.floor(sheetOutCols)))
      const sheet = composeSpriteSheetGrid(resultCanvases, cols)
      sheet.toBlob((blob) => {
        if (!blob) {
          message.error(t('roninProFlowSheetFailed'))
          return
        }
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'roninpro_flow_spritesheet.png'
        a.click()
        URL.revokeObjectURL(a.href)
        message.success(t('roninProFlowSheetOk'))
      }, 'image/png')
    } catch (e) {
      message.error(t('roninProFlowSheetFailed') + ': ' + String(e))
    }
  }

  const onInputModeChange = (m: InputMode) => {
    setInputMode(m)
    clearResults()
  }

  const originalPreviewSrc =
    inputMode === 'sheet' ? spritePreviewUrl : firstFilePreviewUrl

  return (
    <div style={{ maxWidth: 960 }}>
      <Title level={5} style={{ marginTop: 0, marginBottom: 12 }}>
        {t('roninProFlowModuleTitle')}
      </Title>

      <div style={{ marginBottom: 12 }}>
        <Text type="secondary" style={{ marginRight: 12 }}>
          {t('roninProFlowInputMode')}
        </Text>
        <Radio.Group value={inputMode} onChange={(e) => onInputModeChange(e.target.value)}>
          <Radio value="files">{t('roninProFlowInputFiles')}</Radio>
          <Radio value="sheet">{t('roninProFlowInputSheet')}</Radio>
        </Radio.Group>
      </div>

      {inputMode === 'files' ? (
        <StashDropZone
          onStashDrop={(f) => {
            const uid = `${Date.now()}-${f.name}`
            setFileList((prev) => [...prev, { uid, name: f.name, originFileObj: f } as UploadFile])
            clearResults()
          }}
        >
          <Dragger
            accept={IMAGE_ACCEPT.join(',')}
            multiple
            fileList={fileList}
            beforeUpload={(file) => {
              setFileList((prev) => [
                ...prev,
                { uid: file.uid, name: file.name, originFileObj: file } as UploadFile,
              ])
              clearResults()
              return false
            }}
            onRemove={(file) => {
              setFileList((prev) => prev.filter((x) => x.uid !== file.uid))
              clearResults()
              return true
            }}
          >
            <p className="ant-upload-text">{t('roninProFlowUploadHint')}</p>
          </Dragger>
        </StashDropZone>
      ) : (
        <StashDropZone
          onStashDrop={(f) => {
            setSpriteSheetFile(f)
            clearResults()
          }}
        >
          <Dragger
            accept={IMAGE_ACCEPT.join(',')}
            maxCount={1}
            fileList={
              spriteSheetFile
                ? ([{ uid: 'sheet', name: spriteSheetFile.name }] as UploadFile[])
                : []
            }
            beforeUpload={(file) => {
              setSpriteSheetFile(file)
              clearResults()
              return false
            }}
            onRemove={() => {
              setSpriteSheetFile(null)
              clearResults()
              return true
            }}
          >
            <p className="ant-upload-text">{t('roninProFlowSheetUploadHint')}</p>
          </Dragger>
        </StashDropZone>
      )}

      {inputMode === 'sheet' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <span>
            <Text type="secondary">{t('roninProFlowSheetCols')}:</Text>
            <InputNumber
              min={1}
              max={64}
              value={spriteCols}
              onChange={(v) => setSpriteCols(v ?? 4)}
              style={{ width: 72, marginLeft: 8 }}
            />
          </span>
          <span>
            <Text type="secondary">{t('roninProFlowSheetRows')}:</Text>
            <InputNumber
              min={1}
              max={64}
              value={spriteRows}
              onChange={(v) => setSpriteRows(v ?? 1)}
              style={{ width: 72, marginLeft: 8 }}
            />
          </span>
        </div>
      )}

      {loadedImages.length > 0 && (
        <Text type="secondary" style={{ display: 'block', marginTop: 8, fontSize: 12 }}>
          {t('roninProFlowFramesCount', { n: loadedImages.length })}
          {loadedImages[0] &&
            ` · ${loadedImages[0] instanceof HTMLCanvasElement ? loadedImages[0].width : loadedImages[0].naturalWidth}×${
              loadedImages[0] instanceof HTMLCanvasElement ? loadedImages[0].height : loadedImages[0].naturalHeight
            }`}
        </Text>
      )}

      {originalPreviewSrc && (
        <div
          style={{
            marginTop: 12,
            padding: 14,
            width: '100%',
            boxSizing: 'border-box',
            background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
            borderRadius: 8,
            border: '1px solid #9a8b78',
          }}
        >
          <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
            {t('roninProFlowOriginalPreview')}
          </Text>
          <StashableImage
            src={originalPreviewSrc}
            alt=""
            style={{
              maxWidth: '100%',
              width: 'auto',
              height: 'auto',
              maxHeight: 440,
              display: 'block',
              imageRendering: 'pixelated',
            }}
          />
        </div>
      )}

      <Text type="secondary" style={{ display: 'block', marginTop: 16, marginBottom: 8 }}>
        {t('roninProFlowModuleDesc')}
      </Text>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
        {t('roninProAdvancedPixelHint')}
      </Typography.Paragraph>

      <Divider style={{ margin: '16px 0' }} />

      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <div>
          <Text type="secondary">{t('roninProFlowQuality')}</Text>
          <Radio.Group
            value={quality}
            onChange={(e) => setQuality(e.target.value)}
            style={{ display: 'block', marginTop: 8 }}
          >
            <Radio value="fast">{t('roninProFlowQualityFast')}</Radio>
            <Radio value="balanced">{t('roninProFlowQualityBalanced')}</Radio>
            <Radio value="high">{t('roninProFlowQualityHigh')}</Radio>
          </Radio.Group>
        </div>

        <Checkbox checked={bidirectional} onChange={(e) => setBidirectional(e.target.checked)}>
          {t('roninProFlowBidirectional')}
        </Checkbox>
        <Checkbox checked={smoothFlow} onChange={(e) => setSmoothFlow(e.target.checked)}>
          {t('roninProFlowSmooth')}
        </Checkbox>

        <div>
          <Text type="secondary">{t('roninProFlowMaxMotion')}</Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <Slider
              min={0.1}
              max={0.6}
              step={0.05}
              value={maxMotionRel}
              onChange={setMaxMotionRel}
              style={{ flex: 1 }}
            />
            <InputNumber
              min={0.1}
              max={0.6}
              step={0.05}
              value={maxMotionRel}
              onChange={(v) => setMaxMotionRel(typeof v === 'number' ? v : 0.35)}
              style={{ width: 88 }}
            />
          </div>
        </div>

        <div>
          <Text type="secondary">{t('roninProFlowAlpha')}</Text>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            <Slider
              min={0}
              max={1}
              step={0.05}
              value={alpha}
              onChange={setAlpha}
              style={{ flex: 1 }}
            />
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              value={alpha}
              onChange={(v) => setAlpha(typeof v === 'number' ? v : 0.5)}
              style={{ width: 88 }}
            />
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {t('roninProFlowAlphaHint')}
          </Text>
        </div>

        <Checkbox checked={nearest} onChange={(e) => setNearest(e.target.checked)}>
          {t('roninProFlowNearest')}
        </Checkbox>

        <Space wrap>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={loading}
            disabled={loadedImages.length < 2}
            onClick={runInterpolate}
          >
            {t('roninProFlowRun')}
          </Button>
          {progress && (
            <Text type="secondary">
              {t('roninProFlowProgress', { done: progress.done, total: progress.total })}
            </Text>
          )}
          <Button icon={<DownloadOutlined />} disabled={resultUrls.length === 0} onClick={downloadZip}>
            {t('roninProFlowDownloadZip')}
          </Button>
          <span>
            <Text type="secondary" style={{ marginRight: 8 }}>
              {t('roninProFlowSheetOutCols')}
            </Text>
            <InputNumber
              min={1}
              max={Math.max(1, resultCanvases.length)}
              value={sheetOutCols}
              onChange={(v) => setSheetOutCols(typeof v === 'number' ? v : 1)}
              disabled={resultCanvases.length === 0}
              style={{ width: 72 }}
            />
          </span>
          <Button
            icon={<PictureOutlined />}
            disabled={resultCanvases.length === 0}
            onClick={downloadSpriteSheet}
          >
            {t('roninProFlowDownloadSheet')}
          </Button>
        </Space>
      </Space>

      {resultUrls.length > 0 && (
        <>
          <Divider />
          <Text strong style={{ display: 'block', marginBottom: 8 }}>
            {t('roninProFlowResultTitle')}
          </Text>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              maxHeight: 280,
              overflow: 'auto',
              padding: 8,
              background: 'repeating-conic-gradient(#c9bfb0 0% 25%, #e4dbcf 0% 50%) 50% / 16px 16px',
              borderRadius: 8,
              border: '1px solid #9a8b78',
            }}
          >
            {resultUrls.map((url, i) => (
              <div key={i} style={{ position: 'relative', display: 'inline-block' }}>
                <StashableImage
                  src={url}
                  alt={`${i + 1}`}
                  style={{
                    width: 56,
                    height: 56,
                    objectFit: 'contain',
                    imageRendering: 'pixelated',
                    border: '1px solid rgba(0,0,0,0.2)',
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
                    textShadow: '0 0 2px #000',
                  }}
                >
                  {i + 1}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
