"use client"
import { useEffect, useState } from "react"
import { api, ApiFailure } from "@/lib/client/api"
import type { Collection, Item, Tag } from "@/lib/client/types"
import { Icon } from "./icons"
import { Button, Modal } from "./ui"

export function TagDialog({ initial, allTags, onSave, onClose, title = "Tags" }: { initial: string[]; allTags: Tag[]; onSave: (tags: string[]) => Promise<void>; onClose: () => void; title?: string }) {
  const [tags, setTags] = useState<string[]>(initial)
  const [input, setInput] = useState("")
  const [busy, setBusy] = useState(false)
  const add = (raw: string) => {
    const t = raw.trim().replace(/^#/, "").slice(0, 50)
    if (t && !tags.some((x) => x.toLowerCase() === t.toLowerCase()) && tags.length < 20) setTags([...tags, t])
    setInput("")
  }
  const suggestions = allTags.filter((t) => !tags.some((x) => x.toLowerCase() === t.name.toLowerCase()) && t.name.toLowerCase().includes(input.toLowerCase())).slice(0, 8)
  return (
    <Modal title={title} onClose={onClose}>
      <div className="mb-3 flex flex-wrap gap-2">
        {tags.map((t) => (
          <span key={t} className="flex items-center gap-1 rounded-full bg-accent-soft px-2.5 py-1 text-sm text-accent">
            #{t}
            <button onClick={() => setTags(tags.filter((x) => x !== t))} aria-label={`Remove ${t}`}>
              <Icon.close width={12} height={12} />
            </button>
          </span>
        ))}
        {!tags.length ? <span className="text-sm text-ink-3">No tags yet</span> : null}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          add(input)
        }}
      >
        <label htmlFor="tag-input" className="sr-only">
          Add a tag
        </label>
        <input id="tag-input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type a tag and press Enter" className="w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
      </form>
      {suggestions.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button key={s.id} onClick={() => add(s.name)} className="rounded-full border border-line px-2.5 py-1 text-sm text-ink-2 hover:border-accent">
              #{s.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          kind="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            const final = input.trim() ? [...tags, input.trim()] : tags
            await onSave(final).finally(() => setBusy(false))
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  )
}

export function CollectionDialog({ item, collections, onSave, onCreate, onClose }: { item: Item; collections: Collection[]; onSave: (ids: string[]) => Promise<void>; onCreate: (name: string) => Promise<Collection | null>; onClose: () => void }) {
  const [ids, setIds] = useState<string[]>(item.collection_ids)
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  return (
    <Modal title="Collections" onClose={onClose}>
      <ul className="max-h-64 space-y-1 overflow-y-auto">
        {collections.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-panel-2">
              <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} className="h-4 w-4 accent-[var(--accent)]" />
              <span className="flex-1">{c.name}</span>
              <span className="text-xs text-ink-3">{c.item_count}</span>
            </label>
          </li>
        ))}
        {!collections.length ? <li className="px-2 py-2 text-sm text-ink-3">No collections yet. Create one below.</li> : null}
      </ul>
      <form
        className="mt-3 flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!name.trim()) return
          const c = await onCreate(name.trim())
          if (c) setIds([...ids, c.id])
          setName("")
        }}
      >
        <label htmlFor="new-col" className="sr-only">
          New collection
        </label>
        <input id="new-col" value={name} onChange={(e) => setName(e.target.value)} placeholder="New collection" className="flex-1 rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
        <Button type="submit">Create</Button>
      </form>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          kind="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            await onSave(ids).finally(() => setBusy(false))
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  )
}

export function ShareDialog({ target, onClose }: { target: { item_id?: string; collection_id?: string; label: string }; onClose: () => void }) {
  const [days, setDays] = useState<string>("7")
  const [allowDownload, setAllowDownload] = useState(true)
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  return (
    <Modal title={`Share ${target.label}`} onClose={onClose}>
      {!url ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-2">Anyone with the link can open it without an account. You can turn it off at any time.</p>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">Link stops working after</span>
            <select value={days} onChange={(e) => setDays(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-3 py-2">
              <option value="1">1 day</option>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="">Never (until you turn it off)</option>
            </select>
          </label>
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Allow downloading files
          </label>
          {error ? <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button
              kind="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setError(null)
                try {
                  const r = await api.createShare({
                    item_id: target.item_id,
                    collection_id: target.collection_id,
                    allow_download: allowDownload,
                    ...(days ? { expires_in_days: Number(days) } : {}),
                  })
                  setUrl(r.url)
                } catch (e) {
                  setError(e instanceof ApiFailure ? e.message : "Could not create the link")
                } finally {
                  setBusy(false)
                }
              }}
            >
              Create link
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-2">Copy the link now. For your privacy it cannot be shown again; you can create a new one any time.</p>
          <div className="flex gap-2">
            <input readOnly value={url} className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-2 text-sm" onFocus={(e) => e.target.select()} aria-label="Share link" />
            <Button
              kind="primary"
              onClick={async () => {
                await navigator.clipboard.writeText(url).catch(() => {})
                setCopied(true)
              }}
            >
              {copied ? <Icon.check /> : <Icon.copy />} {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={onClose}>Done</Button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export function EditDialog({ item, onSave, onClose }: { item: Item; onSave: (patch: { title: string | null; body: string | null }) => Promise<void>; onClose: () => void }) {
  const [title, setTitle] = useState(item.title ?? "")
  const [body, setBody] = useState(item.body ?? "")
  const [busy, setBusy] = useState(false)
  const isNote = item.type === "note"
  return (
    <Modal title={isNote ? "Edit note" : "Edit caption"} onClose={onClose} wide>
      <label htmlFor="edit-title" className="mb-1 block text-sm font-medium">
        Title (optional)
      </label>
      <input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} className="mb-3 w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" maxLength={500} />
      <label htmlFor="edit-body" className="mb-1 block text-sm font-medium">
        {isNote ? "Text" : "Caption"}
      </label>
      <textarea id="edit-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} className="w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          kind="primary"
          disabled={busy || (isNote && !body.trim() && !title.trim())}
          onClick={async () => {
            setBusy(true)
            await onSave({ title: title.trim() || null, body: body || null }).finally(() => setBusy(false))
          }}
        >
          Save
        </Button>
      </div>
    </Modal>
  )
}

export function HistoryDialog({ item, onRestore, onClose }: { item: Item; onRestore: (v: { title: string | null; body: string | null }) => Promise<void>; onClose: () => void }) {
  const [versions, setVersions] = useState<{ version: number; title: string | null; body: string | null; created_at: string }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api
      .versions(item.id)
      .then((r) => setVersions(r.versions))
      .catch(() => setError("Could not load history"))
  }, [item.id])
  return (
    <Modal title="Version history" onClose={onClose} wide>
      {error ? <p className="text-danger">{error}</p> : null}
      {!versions && !error ? <p className="text-ink-2">Loading…</p> : null}
      {versions && !versions.length ? <p className="text-ink-2">No earlier text versions. Only text and title edits are kept.</p> : null}
      <ul className="space-y-3">
        {versions?.map((v) => (
          <li key={v.version} className="rounded-xl border border-line p-3">
            <p className="mb-1 text-xs text-ink-3">Replaced {new Date(v.created_at).toLocaleString()}</p>
            {v.title ? <p className="font-medium">{v.title}</p> : null}
            <p className="line-clamp-6 whitespace-pre-wrap text-sm">{v.body}</p>
            <div className="mt-2 flex justify-end">
              <Button onClick={() => onRestore({ title: v.title, body: v.body })}>
                <Icon.restore width={15} height={15} /> Restore this version
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Modal>
  )
}

export function ConfirmDialog({ title, text, confirmLabel, danger, onConfirm, onClose }: { title: string; text: string; confirmLabel: string; danger?: boolean; onConfirm: () => Promise<void> | void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-sm text-ink-2">{text}</p>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          kind={danger ? "danger" : "primary"}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onConfirm()
            } finally {
              setBusy(false)
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  )
}
