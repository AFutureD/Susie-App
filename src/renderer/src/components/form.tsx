import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-muted/70">{hint}</span> : null}
    </label>
  )
}

/**
 * Field 的非 label 版：内容是含按钮的复合控件时用——label 会把首个可标控件
 * （可能是个按钮）的可访问名替换成标签文本，且点击标签会代理触发它。
 */
export function FieldGroup({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-ink-muted/70">{hint}</span> : null}
    </div>
  )
}

/** 表单分节：小节标题 + 右延 hairline，内容纵向 gap-3（用于较长的编辑表单，如助手编辑） */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="shrink-0 text-xs font-semibold text-ink-muted">{title}</span>
        <span className="h-px flex-1 bg-line/70" />
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  )
}

const controlClass =
  'w-full rounded-md border border-line bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-accent/60'

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${controlClass} ${props.className ?? ''}`} />
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${controlClass} font-mono text-xs leading-5 ${props.className ?? ''}`} />
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${controlClass} ${props.className ?? ''}`} />
}

export function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-(--accent)"
      />
      <span>{label}</span>
    </label>
  )
}

type ButtonVariant = 'primary' | 'ghost' | 'danger'

const buttonVariants: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:opacity-90',
  ghost: 'border border-line text-ink hover:bg-raised',
  danger: 'border border-line text-red-500 hover:bg-red-500/10',
}

export function Button({
  variant = 'ghost',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${buttonVariants[variant]} ${className ?? ''}`}
    />
  )
}

export function ErrorText({ message }: { message: string | null }) {
  if (!message) return null
  return <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-500">{message}</p>
}
