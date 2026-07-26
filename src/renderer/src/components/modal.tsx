import type { ReactNode } from 'react'

/**
 * 通用弹窗壳（点遮罩关闭、面板阻止冒泡）：宽度/内边距由 panelClassName 定制，
 * 滚动策略也在其中选择——整体 `overflow-y-auto`，或 `flex flex-col` + 内部滚动区。
 */
export function Modal({
  title,
  panelClassName = 'w-96 p-4',
  onClose,
  children,
}: {
  title?: string
  panelClassName?: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        className={`max-h-[70vh] rounded-xl border border-line bg-raised shadow-xl ${panelClassName}`}
        onClick={(event) => event.stopPropagation()}
      >
        {title !== undefined && <h3 className="mb-3 shrink-0 text-sm font-semibold">{title}</h3>}
        {children}
      </div>
    </div>
  )
}
