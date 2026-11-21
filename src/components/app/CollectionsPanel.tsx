"use client"
import { useState } from "react"
import type { Collection, Tag } from "@/lib/client/types"
import { Icon } from "./icons"
import { Button } from "./ui"

/** Collections and tags: open, create, rename, delete, share. */
export function CollectionsPanel({
  collections,
  tags,
  onOpenCollection,
  onOpenTag,
  onCreate,
  onRename,
  onDelete,
  onShare,
  onRenameTag,
  onDeleteTag,
}: {
  collections: Collection[]
  tags: Tag[]
  onOpenCollection: (c: Collection) => void
  onOpenTag: (t: Tag) => void
  onCreate: (name: string) => Promise<unknown>
  onRename: (c: Collection) => void
  onDelete: (c: Collection) => void
  onShare: (c: Collection) => void
  onRenameTag: (t: Tag) => void
  onDeleteTag: (t: Tag) => void
}) {
  const [name, setName] = useState("")
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-5 md:px-6">
      <h2 className="mb-3 text-lg font-semibold">Collections</h2>
      <form
        className="mb-4 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          await onCreate(name.trim())
          setName("")
        }}
      >
        <label htmlFor="col-name" className="sr-only">
          New collection name
        </label>
        <input id="col-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection, e.g. Goa trip" className="flex-1 rounded-xl border border-line bg-panel px-3 py-2 outline-none focus:border-accent" maxLength={80} />
        <Button type="submit" kind="primary">
          <Icon.plus width={16} height={16} /> Create
        </Button>
      </form>
      {!collections.length ? <p className="mb-8 text-sm text-ink-3">No collections yet. Group related items, like a trip or a project.</p> : null}
      <ul className="mb-8 grid gap-2 sm:grid-cols-2">
        {collections.map((c) => (
          <li key={c.id} className="flex items-center gap-2 rounded-2xl border border-line bg-panel p-3">
            <button onClick={() => onOpenCollection(c)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
                <Icon.folder />
              </span>
              <span className="min-w-0">
                <span className="block truncate font-medium">{c.name}</span>
                <span className="text-xs text-ink-3">
                  {c.item_count} {c.item_count === 1 ? "item" : "items"}
                </span>
              </span>
            </button>
            <button onClick={() => onShare(c)} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label={`Share ${c.name}`}>
              <Icon.share width={16} height={16} />
            </button>
            <button onClick={() => onRename(c)} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label={`Rename ${c.name}`}>
              <Icon.edit width={16} height={16} />
            </button>
            <button onClick={() => onDelete(c)} className="rounded-lg p-1.5 text-danger hover:bg-danger-soft" aria-label={`Delete ${c.name}`}>
              <Icon.trash width={16} height={16} />
            </button>
          </li>
        ))}
      </ul>

      <h2 className="mb-3 text-lg font-semibold">Tags</h2>
      {!tags.length ? <p className="text-sm text-ink-3">No tags yet. Add tags from any item’s menu.</p> : null}
      <ul className="flex flex-wrap gap-2">
        {tags.map((t) => (
          <li key={t.id} className="flex items-center gap-1 rounded-full border border-line bg-panel py-1 pl-3 pr-1 text-sm">
            <button onClick={() => onOpenTag(t)} className="text-accent">
              #{t.name} <span className="text-ink-3">{t.item_count}</span>
            </button>
            <button onClick={() => onRenameTag(t)} className="rounded-full p-1 text-ink-3 hover:bg-panel-2" aria-label={`Rename tag ${t.name}`}>
              <Icon.edit width={13} height={13} />
            </button>
            <button onClick={() => onDeleteTag(t)} className="rounded-full p-1 text-ink-3 hover:bg-danger-soft hover:text-danger" aria-label={`Delete tag ${t.name}`}>
              <Icon.close width={13} height={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
