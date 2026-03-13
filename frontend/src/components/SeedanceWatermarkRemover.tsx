/**
 * Seedance 2.0 视频水印去除
 * 参考: https://github.com/SamurAIGPT/seedance-2.0-watermark-remover
 */
import { useEffect, useRef, useState } from 'react'
import { InboxOutlined, DownloadOutlined, ReloadOutlined, CodeOutlined } from '@ant-design/icons'
import { Alert, Button, Collapse, Progress, Space, Typography, Upload, message } from 'antd'
import type { UploadFile } from 'antd'
import { useLanguage } from '../i18n/context'
import {
  createWatermarkJob,
  getWatermarkJob,
  getWatermarkResultUrl,
  type WatermarkJob,
} from '../api'

const { Dragger } = Upload
const { Text } = Typography

const ALLOWED = ['.mp4', '.mov', '.webm', '.avi', '.mkv']
const MAX_MB = 200
const POLL_INTERVAL = 2000

export default function SeedanceWatermarkRemover() {
  const { t } = useLanguage()
  const [file, setFile] = useState<File | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<WatermarkJob | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }

  useEffect(() => {
    return stopPolling
  }, [])

  useEffect(() => {
    if (!jobId || !job || job.status === 'completed' || job.status === 'failed') {
      stopPolling()
      return
    }
    const tick = async () => {
      try {
        const data = await getWatermarkJob(jobId)
        setJob(data)
        if (data.status === 'completed') {
          stopPolling()
          message.success(t('seedanceWatermarkDone'))
        } else if (data.status === 'failed') {
          stopPolling()
          message.error(data.error?.message || t('seedanceWatermarkFailed'))
        }
      } catch {
        stopPolling()
      }
    }
    pollRef.current = setInterval(tick, POLL_INTERVAL)
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [jobId, job?.status, t])

  const handleSubmit = async () => {
    if (!file) return
    setSubmitting(true)
    setJob(null)
    setJobId(null)
    try {
      const { job_id } = await createWatermarkJob(file)
      setJobId(job_id)
      setJob({ id: job_id, status: 'queued', progress: 0 })
    } catch (e) {
      message.error(String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleReset = () => {
    stopPolling()
    setFile(null)
    setJobId(null)
    setJob(null)
  }

  const handleDownload = async () => {
    if (!jobId) return
    setDownloading(true)
    try {
      const res = await fetch(getWatermarkResultUrl(jobId))
      if (!res.ok) {
        let msg = res.statusText
        try {
          const err = await res.json()
          msg = (err as { detail?: string }).detail ?? msg
        } catch {
          msg = `${res.status}: ${msg}`
        }
        throw new Error(msg)
      }
      const blob = await res.blob()
      if (blob.size === 0) throw new Error('文件为空')
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = file?.name ? file.name.replace(/\.[^.]+$/, '') + '_clean.mp4' : 'clean.mp4'
      a.click()
      URL.revokeObjectURL(url)
      message.success(t('seedanceWatermarkDownloadSuccess'))
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      message.error(`${t('seedanceWatermarkDownloadFailed')} (${errMsg})`)
      console.error('Download error:', e)
    } finally {
      setDownloading(false)
    }
  }

  const isProcessing = job && (job.status === 'queued' || job.status === 'processing')
  const isCompleted = job?.status === 'completed'

  return (
    <div style={{ width: '100%', maxWidth: 640 }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Collapse
          items={[
            {
              key: 'deploy',
              label: (
                <span>
                  <CodeOutlined style={{ marginRight: 8 }} />
                  {t('seedanceWatermarkDeployTitle')}
                </span>
              ),
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Text type="secondary">{t('seedanceWatermarkDeployStep1')}</Text>
                  <Text type="secondary">{t('seedanceWatermarkDeployStep2')}</Text>
                  <Text type="secondary">{t('seedanceWatermarkDeployStep3')}</Text>
                  <Alert
                    type="info"
                    message={t('seedanceWatermarkDeployCmd')}
                    description={
                      <Space direction="vertical" style={{ width: '100%', marginTop: 8 }}>
                        <div>
                          <Text strong>{t('seedanceWatermarkDeployCmdWin')}</Text>
                          <pre style={{ margin: '4px 0 0', padding: 8, background: '#f5f5f5', borderRadius: 4, fontSize: 12 }}>
                            {t('seedanceWatermarkDeployCmdWinLine1')}{'\n'}
                            {t('seedanceWatermarkDeployCmdWinLine2')}
                          </pre>
                        </div>
                        <div>
                          <Text strong>{t('seedanceWatermarkDeployCmdMac')}</Text>
                          <pre style={{ margin: '4px 0 0', padding: 8, background: '#f5f5f5', borderRadius: 4, fontSize: 12 }}>
                            {t('seedanceWatermarkDeployCmdMacLine1')}{'\n'}
                            {t('seedanceWatermarkDeployCmdMacLine2')}
                          </pre>
                        </div>
                      </Space>
                    }
                    showIcon
                  />
                </Space>
              ),
            },
          ]}
          defaultActiveKey={['deploy']}
        />
        <Text type="secondary">{t('seedanceWatermarkHint')}</Text>

        <Dragger
          name="file"
          multiple={false}
          accept={ALLOWED.join(',')}
          maxCount={1}
          disabled={!!isProcessing}
          fileList={file ? [{ uid: '1', name: file.name, size: file.size } as UploadFile] : []}
          beforeUpload={(f) => {
            const ext = '.' + (f.name.split('.').pop() || '').toLowerCase()
            if (!ALLOWED.includes(ext)) {
              message.error(t('formatError', { formats: ALLOWED.join(' ') }))
              return Upload.LIST_IGNORE
            }
            if (f.size > MAX_MB * 1024 * 1024) {
              message.error(t('sizeError'))
              return Upload.LIST_IGNORE
            }
            setFile(f)
            return false
          }}
          onRemove={() => setFile(null)}
          style={{ padding: 32 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ fontSize: 48, color: '#b55233' }} />
          </p>
          <p className="ant-upload-text">{t('seedanceWatermarkUpload')}</p>
          <p className="ant-upload-hint">{t('uploadFormats')}</p>
        </Dragger>

        {file && !isProcessing && !isCompleted && (
          <Button
            type="primary"
            size="large"
            onClick={handleSubmit}
            disabled={submitting}
            loading={submitting}
          >
            {t('seedanceWatermarkStart')}
          </Button>
        )}

        {isProcessing && (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Progress
              percent={job?.progress ?? 0}
              status="active"
              showInfo={job?.status === 'processing'}
            />
            <Text type="secondary">
              {job?.status === 'queued' ? t('seedanceWatermarkQueued') : t('seedanceWatermarkProcessing')}
            </Text>
          </Space>
        )}

        {job?.status === 'failed' && (
          <Text type="danger">{job.error?.message || t('seedanceWatermarkFailed')}</Text>
        )}

        {isCompleted && jobId && (
          <Space>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              loading={downloading}
              onClick={handleDownload}
            >
              {t('seedanceWatermarkDownload')}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={handleReset}>
              {t('seedanceWatermarkReset')}
            </Button>
          </Space>
        )}
      </Space>
    </div>
  )
}
