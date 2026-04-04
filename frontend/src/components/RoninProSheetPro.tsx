import { Space, Typography } from 'antd'
import { useLanguage } from '../i18n/context'
import SpriteSheetAdjust from './SpriteSheetAdjust'

const { Text } = Typography

/** RoninPro — 单图调整 Pro：在精灵表调整流程上接入整图均分 / 网格拆分 / 透明拆分，并支持逐帧边缘裁剪与实时合成分辨率 */
export default function RoninProSheetPro() {
  const { t } = useLanguage()
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Text type="secondary" style={{ display: 'block', maxWidth: 800, lineHeight: 1.65 }}>
        {t('roninProSheetProIntro')}
      </Text>
      <SpriteSheetAdjust integratedSplit />
    </Space>
  )
}
