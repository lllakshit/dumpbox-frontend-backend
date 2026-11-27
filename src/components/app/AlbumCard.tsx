"use client"
import { useState } from "react"
import type { FileMeta, Item } from "@/lib/client/types"
import { useFileUrls, type ItemAction } from "./ItemCard"
import { Icon } from "./icons"
import { PhotoViewer } from "./PhotoViewer"
import { timeLabel } from "./ui"

/**
 * Photos sent together, drawn as one WhatsApp-style grid bubble: 2 side by side, 3 as one wide plus two,
 * 4+ as 2×2 with "+N". Click a photo to open it full screen; the viewer carries that photo's actions.
 */
export function AlbumCard({ newestFirst, onAction }: { newestFirst: Item[]; onAction: (a: ItemAction, item: Item) => void }) {
  const [open, setOpen] = useState<number | null>(null)
  const items = [...newestFirst].reverse() // in the order they were sent
  const photos = items.map((item) => ({ file: item.files[0], item }))
  const caption = items.map((i) => i.body?.trim() ?? "").find(Boolean) ?? ""
  const n = photos.length
  const last = items[items.length - 1]

  const tile = (k: number, wide = false, more = 0) => (
    <Tile key={photos[k].file.id} file={photos[k].file} label={`Open photo ${k + 1} of ${n}`} wide={wide} more={more} onOpen={() => setOpen(k)} />
  )

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-[min(26rem,80%)]">
        <article className="rounded-2xl rounded-br-md border border-line bg-bubble p-1 shadow-[var(--shadow)]" aria-label={`Album of ${n} photos`}>
          <div className="grid grid-cols-2 gap-[3px] overflow-hidden rounded-xl">
            {n === 2 ? [tile(0), tile(1)] : null}
            {n === 3 ? [tile(0, true), tile(1), tile(2)] : null}
            {n >= 4 ? [tile(0), tile(1), tile(2), tile(3, false, n - 4)] : null}
          </div>
          {caption ? <p className="whitespace-pre-wrap break-words px-2.5 pt-2">{caption}</p> : null}
          <footer className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-xs text-ink-3">
            <span>{n} photos</span>
            {items[0].tags.map((t) => (
              <span key={t.id} className="rounded-full bg-accent-soft px-2 py-0.5 text-accent">
                #{t.name}
              </span>
            ))}
            <span className="ml-auto flex items-center gap-1.5">
              {items.some((i) => i.pinned) ? <Icon.pin width={13} height={13} aria-label="Has pinned photos" /> : null}
              {items.some((i) => i.starred) ? <Icon.star width={13} height={13} className="fill-current text-warn" aria-label="Has starred photos" /> : null}
            <time dateTime={last.created_at}>
              {timeLabel(last.created_at)}
            </time>
            </span>
          </footer>
        </article>
      </div>
      {open !== null ? <PhotoViewer photos={photos} start={open} onClose={() => setOpen(null)} onAction={onAction} /> : null}
    </div>
  )
}

function Tile({ file, label, wide, more, onOpen }: { file: FileMeta; label: string; wide: boolean; more: number; onOpen: () => void }) {
  const { urls, ref } = useFileUrls(file)
  return (
    <div ref={ref} className={wide ? "col-span-2 aspect-[2/1]" : "aspect-square"}>
      <button type="button" onClick={onOpen} aria-label={label} className="relative block h-full w-full cursor-zoom-in bg-panel-2">
        {urls ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={urls.view} alt={file.file_name} loading="lazy" className="h-full w-full object-cover" />
        ) : null}
        {more > 0 ? <span className="absolute inset-0 grid place-items-center bg-black/55 text-2xl font-semibold text-white">+{more}</span> : null}
      </button>
    </div>
  )
}
