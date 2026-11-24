"use client"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { api } from "@/lib/client/api"
import type { FileMeta, Item } from "@/lib/client/types"
import { Icon } from "./icons"
import { Linkified, formatBytes, timeLabel } from "./ui"

/** Signed file URLs are cached for 50 minutes (they are valid for 60). */
const urlCache = new Map<string, { view: string; download: string; at: number }>()
async function fileUrls(id: string) {
  const hit = urlCache.get(id)
  if (hit && Date.now() - hit.at < 50 * 60_000) return hit
  const r = await api.fileUrls(id)
  const v = { view: r.view_url, download: r.download_url, at: Date.now() }
  urlCache.set(id, v)
  return v
}

function useFileUrls(file: FileMeta | undefined, enabled = true) {
  const [urls, setUrls] = useState<{ view: string; download: string } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!file || !enabled || !ref.current) return
    let cancelled = false
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          io.disconnect()
          fileUrls(file.id)
            .then((u) => !cancelled && setUrls(u))
            .catch(() => {})
        }
      },
      { rootMargin: "400px" },
    )
    io.observe(ref.current)
    return () => {
      cancelled = true
      io.disconnect()
    }
  }, [file, enabled])
  return { urls, ref }
}

export type ItemAction =
  | "star"
  | "pin"
  | "edit"
  | "tags"
  | "collections"
  | "share"
  | "copy"
  | "history"
  | "archive"
  | "trash"
  | "restore"
  | "forever"
  | "event"
  | "task"

export type PendingState = "sending" | "queued" | "failed"

export function ItemCard({
  item,
  pending,
  onAction,
  onRetry,
  selectable,
  selected,
  onToggleSelect,
  highlight,
}: {
  item: Item
  pending?: { state: PendingState; error?: string }
  onAction: (a: ItemAction, item: Item) => void
  onRetry?: () => void
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  highlight?: React.ReactNode
}) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null)
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      const t = e.target as Node
      if (!menuRef.current?.contains(t) && !popRef.current?.contains(t)) setMenu(false)
    }
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(false)
    // The menu floats above the page, so it would drift away from its card when the feed scrolls or the window resizes.
    const dismiss = (e: Event) => {
      if (!popRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener("mousedown", close)
    document.addEventListener("keydown", esc)
    window.addEventListener("scroll", dismiss, true)
    window.addEventListener("resize", dismiss)
    return () => {
      document.removeEventListener("mousedown", close)
      document.removeEventListener("keydown", esc)
      window.removeEventListener("scroll", dismiss, true)
      window.removeEventListener("resize", dismiss)
    }
  }, [menu])

  // Place the menu next to its button, inside the window: below when there is room, otherwise above.
  useLayoutEffect(() => {
    if (!menu) return
    const btn = menuRef.current?.getBoundingClientRect()
    const pop = popRef.current
    if (!btn || !pop) return
    const gap = 6
    const margin = 8
    const vh = window.innerHeight
    const vw = window.innerWidth
    const h = pop.scrollHeight
    const w = pop.offsetWidth
    const below = vh - btn.bottom - gap - margin
    const above = btn.top - gap - margin
    const openUp = h > below && above > below
    const maxHeight = Math.max(120, openUp ? above : below)
    const shown = Math.min(h, maxHeight)
    const top = openUp ? btn.top - gap - shown : btn.bottom + gap
    const left = Math.min(Math.max(margin, btn.left), vw - w - margin)
    setPos({ top, left, maxHeight })
  }, [menu])

  const trashed = Boolean(item.deleted_at)
  const actions: { key: ItemAction; label: string }[] = trashed
    ? [
        { key: "restore", label: "Restore" },
        { key: "forever", label: "Delete forever" },
      ]
    : [
        { key: "star", label: item.starred ? "Unstar" : "Star" },
        { key: "pin", label: item.pinned ? "Unpin" : "Pin" },
        ...(item.type === "note" ? [{ key: "edit" as const, label: "Edit" }] : [{ key: "edit" as const, label: "Edit caption" }]),
        { key: "tags", label: "Tags…" },
        { key: "collections", label: "Collections…" },
        { key: "share", label: "Share link…" },
        { key: "copy", label: "Copy text" },
        { key: "event", label: "Make event…" },
        { key: "task", label: "Make task…" },
        ...(item.version > 1 ? [{ key: "history" as const, label: "Version history" }] : []),
        { key: "archive", label: item.archived_at ? "Unarchive" : "Archive" },
        { key: "trash", label: "Move to trash" },
      ]

  return (
    <div className="group flex justify-end">
      <div className={`relative w-full max-w-[min(42rem,92%)] ${selectable ? "cursor-pointer" : ""}`} onClick={selectable ? onToggleSelect : undefined}>
        <article
          className={`rounded-2xl rounded-br-md border bg-bubble px-3.5 py-3 shadow-[var(--shadow)] ${selected ? "border-accent ring-2 ring-accent/40" : "border-line"} ${pending?.state === "failed" ? "border-danger" : ""}`}
          aria-label={`${item.type} item`}
        >
          {item.title && item.type !== "link" ? <h3 className="mb-1 font-semibold leading-snug break-words">{item.title}</h3> : null}
          <Body item={item} />
          {highlight ? <p className="mt-2 border-t border-line pt-2 text-sm text-ink-2">{highlight}</p> : null}

          <footer className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
            {item.tags.map((t) => (
              <span key={t.id} className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                #{t.name}
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1.5">
              {item.pinned ? <Icon.pin width={13} height={13} aria-label="Pinned" /> : null}
              {item.starred ? <Icon.star width={13} height={13} className="fill-current text-warn" aria-label="Starred" /> : null}
              {pending?.state === "sending" ? <span>Sending…</span> : null}
              {pending?.state === "queued" ? (
                <span className="flex items-center gap-1 text-warn">
                  <Icon.cloudOff width={13} height={13} /> Waiting for connection
                </span>
              ) : null}
              {pending?.state === "failed" ? (
                <span className="text-danger">
                  Not saved{pending.error ? `: ${pending.error}` : ""}{" "}
                  {onRetry ? (
                    <button className="underline" onClick={onRetry}>
                      Retry
                    </button>
                  ) : null}
                </span>
              ) : null}
              <time dateTime={item.created_at}>{timeLabel(item.created_at)}</time>
            </span>
          </footer>
        </article>

        {!pending && !selectable ? (
          <div ref={menuRef} className="absolute -left-10 top-1">
            <button
              onClick={() => {
                setPos(null)
                setMenu((m) => !m)
              }}
              className="rounded-lg p-1.5 text-ink-3 opacity-100 hover:bg-panel-2 md:opacity-0 md:group-hover:opacity-100 md:focus:opacity-100"
              aria-label="Item actions"
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <Icon.more />
            </button>
            {menu && typeof document !== "undefined" ? createPortal(
              <div
                ref={popRef}
                role="menu"
                aria-label="Item actions"
                className="scroll-thin fixed z-50 w-48 overflow-y-auto rounded-xl border border-line bg-panel py-1 shadow-[var(--shadow)]"
                style={pos ? { top: pos.top, left: pos.left, maxHeight: pos.maxHeight } : { top: 0, left: 0, visibility: "hidden" }}
              >
                {actions.map((a) => (
                  <button
                    key={a.key}
                    role="menuitem"
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-panel-2 ${a.key === "trash" || a.key === "forever" ? "text-danger" : ""}`}
                    onClick={() => {
                      setMenu(false)
                      onAction(a.key, item)
                    }}
                  >
                    {a.label}
                  </button>
                ))}
              </div>,
              document.body,
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function Body({ item }: { item: Item }) {
  switch (item.type) {
    case "note":
      return item.body ? (
        <p className="whitespace-pre-wrap break-words leading-relaxed">
          <Linkified text={item.body} />
        </p>
      ) : null
    case "link":
      return <LinkBody item={item} />
    case "location":
      return <PlaceBody item={item} />
    default:
      return (
        <div className="space-y-2">
          {item.body ? (
            <p className="whitespace-pre-wrap break-words">
              <Linkified text={item.body} />
            </p>
          ) : null}
          {item.files.length ? item.files.map((f) => <FileBody key={f.id} file={f} />) : <p className="text-sm text-ink-3">Uploading…</p>}
        </div>
      )
  }
}

function LinkBody({ item }: { item: Item }) {
  const l = item.link
  return (
    <div className="space-y-2">
      {item.body ? <p className="whitespace-pre-wrap break-words">{item.body}</p> : null}
      <a href={item.url ?? "#"} target="_blank" rel="noopener noreferrer nofollow" className="block overflow-hidden rounded-xl border border-line hover:border-accent">
        {l?.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={l.image_url} alt="" referrerPolicy="no-referrer" loading="lazy" className="max-h-48 w-full object-cover" />
        ) : null}
        <div className="p-3">
          <p className="text-xs text-ink-3">{l?.site ?? safeHost(item.url)}</p>
          <p className="font-medium leading-snug break-words">{l?.title ?? item.title ?? item.url}</p>
          {l?.description ? <p className="mt-1 line-clamp-2 text-sm text-ink-2">{l.description}</p> : null}
        </div>
      </a>
    </div>
  )
}

function PlaceBody({ item }: { item: Item }) {
  const loc = item.location
  if (!loc) return null
  const map = `https://www.openstreetmap.org/?mlat=${loc.latitude}&mlon=${loc.longitude}#map=17/${loc.latitude}/${loc.longitude}`
  return (
    <div className="flex items-start gap-3">
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
        <Icon.place />
      </div>
      <div className="min-w-0">
        <p className="font-medium">{loc.label ?? "Dropped pin"}</p>
        <p className="text-xs text-ink-3">
          {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
        </p>
        <a href={map} target="_blank" rel="noopener noreferrer" className="text-sm text-accent underline">
          Open map
        </a>
      </div>
      {item.body ? <p className="whitespace-pre-wrap">{item.body}</p> : null}
    </div>
  )
}

function FileBody({ file }: { file: FileMeta }) {
  const isImage = file.mime_type.startsWith("image/")
  const isAudio = file.mime_type.startsWith("audio/")
  const isVideo = file.mime_type.startsWith("video/")
  const { urls, ref } = useFileUrls(file)

  if (isImage) {
    const ratio = file.width && file.height ? `${file.width} / ${file.height}` : "4 / 3"
    return (
      <div ref={ref}>
        <a href={urls?.view ?? undefined} target="_blank" rel="noopener noreferrer" className="block overflow-hidden rounded-xl bg-panel-2" style={{ aspectRatio: ratio, maxHeight: 360 }}>
          {urls ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={urls.view} alt={file.file_name} loading="lazy" className="h-full w-full object-contain" />
          ) : null}
        </a>
      </div>
    )
  }
  return (
    <div ref={ref} className="rounded-xl border border-line p-2.5">
      {isAudio && urls ? <audio controls src={urls.view} className="mb-2 w-full" preload="none" /> : null}
      {isVideo && urls ? <video controls src={urls.view} className="mb-2 max-h-80 w-full rounded-lg" preload="metadata" /> : null}
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-panel-2 text-ink-2">
          {isAudio ? <Icon.voice /> : <Icon.file />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={file.file_name}>
            {file.file_name}
          </p>
          <p className="text-xs text-ink-3">{formatBytes(file.size_bytes)}</p>
        </div>
        {urls ? (
          <>
            <a href={urls.view} target="_blank" rel="noopener noreferrer" className="rounded-lg px-2 py-1 text-sm text-accent hover:bg-panel-2">
              Open
            </a>
            <a href={urls.download} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label={`Download ${file.file_name}`}>
              <Icon.download />
            </a>
          </>
        ) : null}
      </div>
    </div>
  )
}

function safeHost(url: string | null) {
  try {
    return url ? new URL(url).hostname : ""
  } catch {
    return ""
  }
}
