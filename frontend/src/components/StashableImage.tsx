import { forwardRef } from 'react'
import type { ImgHTMLAttributes } from 'react'

const STASH_DRAG_TYPE = 'application/x-frameronin-stash-url'

interface StashableImageProps extends ImgHTMLAttributes<HTMLImageElement> {
  src: string
  stashName?: string
}

/** 可拖拽到暂存框的图片，继承 img 所有属性 */
const StashableImage = forwardRef<HTMLImageElement, StashableImageProps>(function StashableImage(
  { src, stashName: _stashName, draggable = true, onDragStart, ...props },
  ref,
) {
  const handleDragStart = (e: React.DragEvent<HTMLImageElement>) => {
    e.dataTransfer.setData(STASH_DRAG_TYPE, src)
    e.dataTransfer.effectAllowed = 'copy'
    onDragStart?.(e)
  }

  return (
    <img
      ref={ref}
      src={src}
      draggable={draggable}
      onDragStart={handleDragStart}
      className={`stashable-image ${props.className ?? ''}`.trim()}
      {...props}
    />
  )
})

export default StashableImage
