"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import type { FileMeta, Item } from "@/lib/client/types"
import { fileUrls } from "./fileUrls"
import type { ItemAction } from "./ItemCard"
import { Icon } from "./icons"

export type ViewerPhoto = { file: FileMeta; item: Item }

/**
 * Full-screen photo viewer: the whole photo on black, ← → keys or swipe to move, Esc to close,
 * click (or double-tap) to zoom. With `onAction`, the current photo's main actions sit in the top bar.
 */
export function PhotoViewer({
  photos,
  start,
  onClose,
  onAction,
}: {
  photos: ViewerPhoto[]
  start: number
  onClose: () => void
  onAction?: (a: ItemAction, item: Item) => void
}) {
  const [index, setIndex] = useState(start)
  const [zoom, setZoom] = useState(false)
  const [url, setUrl] = useState<{ id: string; view: string; download: string } | null>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const touch = useRef<{ x: number; y: number } | null>(null)

  // Photos can leave while the viewer is open (moved to trash): stay in range, close when none are left.
  const count = photos.length
  const at = Math.min(index, Math.max(0, count - 1))
  const photo = photos[at]
  useEffect(() => {
    if (!count) onClose()
  }, [count, onClose])

  const go = useCallback(
    (d: number) => {
      setZoom(false)
      setIndex((i) => Math.min(Math.max(0, Math.min(i, count - 1) + d), count - 1))
    },
    [count],
  )

  useEffect(() => {
    if (!photo) return
    let cancelled = false
    fileUrls(photo.file.id)
      .then((u) => !cancelled && setUrl({ id: photo.file.id, view: u.view, download: u.download }))
      .catch(() => {})
    // Warm the neighbours so moving feels instant.
    for (const n of [photos[at - 1], photos[at + 1]]) if (n) fileUrls(n.file.id).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [photo, photos, at])

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const overflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      else if (e.key === "ArrowRight") go(1)
      else if (e.key === "ArrowLeft") go(-1)
    }
    document.addEventListener("keydown", key)
    return () => {
      document.removeEventListener("keydown", key)
      document.body.style.overflow = overflow
      prevFocus?.focus?.()
    }
  }, [go, onClose])

  if (!photo || typeof document === "undefined") return null
  const shown = url?.id === photo.file.id ? url : null
  const item = photo.item
  const trashed = Boolean(item.deleted_at)
  const act = (a: ItemAction, keepOpen: boolean) => {
    if (!keepOpen) onClose()
    onAction?.(a, item)
  }
  const barBtn = "rounded-lg px-2.5 py-1.5 text-sm text-white/90 hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Photo ${at + 1} of ${count}`}
      className="fixed inset-0 z-[60] flex flex-col bg-black text-white"
      onTouchStart={(e) => (touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY })}
      onTouchEnd={(e) => {
        const s = touch.current
        touch.current = null
        if (!s || zoom) return
        const dx = e.changedTouches[0].clientX - s.x
        const dy = e.changedTouches[0].clientY - s.y
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(dx < 0 ? 1 : -1)
        else if (dy > 90 && Math.abs(dy) > Math.abs(dx)) onClose()
      }}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-2 py-2">
        <button ref={closeRef} onClick={onClose} className={barBtn} aria-label="Close">
          <Icon.close />
        </button>
        {count > 1 ? (
          <span className="px-1 text-sm text-white/80" aria-live="polite">
            {at + 1} / {count}
          </span>
        ) : null}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {onAction && !trashed ? (
            <>
              <button className={barBtn} onClick={() => act("star", true)} aria-pressed={item.starred}>
                {item.starred ? "Unstar" : "Star"}
              </button>
              <button className={barBtn} onClick={() => act("pin", true)} aria-pressed={item.pinned}>
                {item.pinned ? "Unpin" : "Pin"}
              </button>
              <button className={barBtn} onClick={() => act("tags", false)}>
                Tags…
              </button>
              <button className={barBtn} onClick={() => act("share", false)}>
                Share…
              </button>
              <button className={`${barBtn} text-red-300`} onClick={() => act("trash", true)}>
                Move to trash
              </button>
            </>
          ) : null}
          {onAction && trashed ? (
            <>
              <button className={barBtn} onClick={() => act("restore", true)}>
                Restore
              </button>
              <button className={`${barBtn} text-red-300`} onClick={() => act("forever", false)}>
                Delete forever
              </button>
            </>
          ) : null}
          {shown ? (
            <a href={shown.download} className={barBtn} aria-label={`Download ${photo.file.file_name}`}>
              <Icon.download />
            </a>
          ) : null}
        </span>
      </div>

      <div className={`relative min-h-0 flex-1 ${zoom ? "overflow-auto" : "overflow-hidden"}`}>
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={photo.file.id}
            src={shown.view}
            alt={photo.file.file_name}
            onClick={() => setZoom((z) => !z)}
            className={zoom ? "mx-auto max-w-none cursor-zoom-out" : "h-full w-full cursor-zoom-in object-contain"}
            style={zoom ? { width: "200%" } : undefined}
            draggable={false}
          />
        ) : (
          <div className="grid h-full place-items-center text-sm text-white/60">Loading…</div>
        )}
        {count > 1 && at > 0 ? (
          <button onClick={() => go(-1)} aria-label="Previous photo" className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 text-2xl leading-none hover:bg-black/70">
            ‹
          </button>
        ) : null}
        {count > 1 && at < count - 1 ? (
          <button onClick={() => go(1)} aria-label="Next photo" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/50 p-3 text-2xl leading-none hover:bg-black/70">
            ›
          </button>
        ) : null}
      </div>
      {item.body?.trim() ? <p className="shrink-0 whitespace-pre-wrap px-4 py-3 text-sm text-white/90">{item.body}</p> : null}
    </div>,
    document.body,
  )
}
