import type { ReactNode } from 'react'
import { FormattedMessage } from 'react-intl'

export function Page({ titleId, actions, children }: { titleId: string; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <FormattedMessage id={titleId} />
        </h1>
        {actions}
      </div>
      {children}
    </div>
  )
}

export function PlaceholderCard({ messageId }: { messageId: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-raised/50 p-6 text-sm text-ink-muted">
      <FormattedMessage id={messageId} />
    </div>
  )
}
