import type { ReactNode } from 'react'
import { FormattedMessage } from 'react-intl'

export function Page({ titleId, children }: { titleId: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 text-xl font-semibold">
        <FormattedMessage id={titleId} />
      </h1>
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
