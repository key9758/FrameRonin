import { ArrowLeftOutlined } from '@ant-design/icons'
import { Button, Card, Typography } from 'antd'
import { useLanguage } from '../i18n/context'
import InfiniteMapScene from './infiniteMap/InfiniteMapScene'

export default function InfiniteMapPlaceholder({ onBack }: { onBack: () => void }) {
  const { t } = useLanguage()
  return (
    <Card
      style={{
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
      styles={{
        body: {
          display: 'flex',
          flexDirection: 'column',
          padding: 16,
        },
      }}
    >
      <div style={{ marginBottom: 12, flexShrink: 0 }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack}>
          {t('backToHome')}
        </Button>
      </div>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 12, flexShrink: 0 }}>
        {t('moduleInfiniteMap')}
      </Typography.Title>
      <InfiniteMapScene />
    </Card>
  )
}
