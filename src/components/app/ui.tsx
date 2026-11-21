"use client"
import { useEffect, useRef, type ReactNode } from "react"
import { Icon } from "./icons"

/** Accessible modal: focus moves in, Escape and the backdrop close it, focus returns on close. */
export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    const first = ref.current?.querySelector<HTMLElement>("input,textarea,select,button:not([data-close])")
    first?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      prev?.focus()
    }
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel p-5 shadow-[var(--shadow)] sm:rounded-2xl ${wide ? "sm:max-w-xl" : "sm:max-w-md"}`}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button data-close onClick={onClose} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Close">
            <Icon.close />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Button({
  children,
  onClick,
  kind = "secondary",
  disabled,
  type = "button",
  className = "",
}: {
  children: ReactNode
  onClick?: () => void
  kind?: "primary" | "secondary" | "danger" | "ghost"
  disabled?: boolean
  type?: "button" | "submit"
  className?: string
}) {
  const styles = {
    primary: "bg-accent text-accent-ink",
    secondary: "border border-line bg-bg text-ink",
    danger: "bg-danger text-white",
    ghost: "text-ink-2 hover:bg-panel-2",
  }[kind]
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium disabled:opacity-50 ${styles} ${className}`}>
      {children}
    </button>
  )
}

export type Toast = { id: number; text: string; tone?: "ok" | "error"; action?: { label: string; run: () => void } }

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-2.5 text-sm shadow-[var(--shadow)] ${t.tone === "error" ? "bg-danger text-white" : "bg-ink text-bg"}`}
        >
          <span>{t.text}</span>
          {t.action ? (
            <button
              className="font-semibold underline"
              onClick={() => {
                t.action!.run()
                dismiss(t.id)
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="opacity-70">
            <Icon.close width={14} height={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function dayLabel(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const y = new Date()
  y.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  if (same(d, today)) return "Today"
  if (same(d, y)) return "Yesterday"
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" })
}

export function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
}

/** Renders the API's search highlight (text with <mark> tags) safely: everything else stays plain text. */
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/(<mark>|<\/mark>)/)
  let on = false
  const out: ReactNode[] = []
  parts.forEach((p, i) => {
    if (p === "<mark>") on = true
    else if (p === "</mark>") on = false
    else if (p) out.push(on ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>)
  })
  return <>{out}</>
}

/** Text with URLs turned into links. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"']+)/g)
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline break-all">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}
