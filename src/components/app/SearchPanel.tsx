"use client"
import { useEffect, useRef, useState } from "react"
import { api, ApiFailure } from "@/lib/client/api"
import { feedCache } from "@/lib/client/outbox"
import { TYPE_LABEL, type Collection, type Item, type ItemType, type Tag } from "@/lib/client/types"
import { Icon } from "./icons"
import { ItemCard, type ItemAction } from "./ItemCard"
import { Highlight } from "./ui"

const TYPES = Object.keys(TYPE_LABEL) as ItemType[]

/** Search with filters. Offline, it searches the items cached on this device. */
export function SearchPanel({ tags, collections, onAction, refreshKey }: { tags: Tag[]; collections: Collection[]; onAction: (a: ItemAction, item: Item) => void; refreshKey: number }) {
  const [q, setQ] = useState("")
  const [types, setTypes] = useState<ItemType[]>([])
  const [tagId, setTagId] = useState("")
  const [collectionId, setCollectionId] = useState("")
  const [starred, setStarred] = useState(false)
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [results, setResults] = useState<{ item: Item; highlight: string }[] | null>(null)
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [offline, setOffline] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  useEffect(() => input.current?.focus(), [])

  const hasFilter = Boolean(q.trim() || types.length || tagId || collectionId || starred || from || to)
  const shown = hasFilter ? results : null

  function params(offset = 0) {
    const p = new URLSearchParams()
    if (q.trim()) p.set("q", q.trim())
    if (types.length) p.set("type", types.join(","))
    if (tagId) p.set("tags", tagId)
    if (collectionId) p.set("collection", collectionId)
    if (starred) p.set("starred", "true")
    if (from) p.set("from", new Date(`${from}T00:00:00`).toISOString())
    if (to) p.set("to", new Date(`${to}T23:59:59.999`).toISOString())
    p.set("limit", "30")
    p.set("offset", String(offset))
    return p
  }

  async function run(offset = 0) {
    const mine = ++seq.current
    setBusy(true)
    try {
      const r = await api.search(params(offset))
      if (mine !== seq.current) return
      setOffline(false)
      setResults((cur) => (offset && cur ? [...cur, ...r.results] : r.results))
      setNextOffset(r.next_offset)
    } catch (e) {
      if (mine !== seq.current) return
      if (e instanceof ApiFailure && e.offline) {
        setOffline(true)
        setResults(localSearch())
        setNextOffset(null)
      }
    } finally {
      if (mine === seq.current) setBusy(false)
    }
  }

  function localSearch() {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return feedCache
      .load<Item>()
      .filter((it) => {
        const hay = [it.title, it.body, it.url, it.link?.title, it.location?.label, ...it.tags.map((t) => t.name), ...it.files.map((f) => f.file_name)].join(" ").toLowerCase()
        return (
          words.every((w) => hay.includes(w)) &&
          (!types.length || types.includes(it.type)) &&
          (!starred || it.starred) &&
          (!tagId || it.tags.some((t) => t.id === tagId)) &&
          (!collectionId || it.collection_ids.includes(collectionId))
        )
      })
      .map((item) => ({ item, highlight: "" }))
  }

  useEffect(() => {
    if (!hasFilter) return
    const t = setTimeout(() => run(0), 250)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, types, tagId, collectionId, starred, from, to, refreshKey])

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-4 md:px-6">
      <div className="relative">
        <Icon.search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <label htmlFor="search" className="sr-only">
          Search everything
        </label>
        <input
          id="search"
          ref={input}
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search notes, links, files, places, tags…"
          className="w-full rounded-2xl border border-line bg-panel py-3 pl-10 pr-3 text-base outline-none focus:border-accent"
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        {TYPES.map((t) => {
          const on = types.includes(t)
          return (
            <button key={t} onClick={() => setTypes(on ? types.filter((x) => x !== t) : [...types, t])} aria-pressed={on} className={`rounded-full border px-3 py-1 text-sm ${on ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2"}`}>
              {TYPE_LABEL[t]}
            </button>
          )
        })}
        <button onClick={() => setStarred(!starred)} aria-pressed={starred} className={`rounded-full border px-3 py-1 text-sm ${starred ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2"}`}>
          Starred
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        <label className="text-xs text-ink-3">
          Tag
          <select value={tagId} onChange={(e) => setTagId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-2 py-2 text-sm text-ink">
            <option value="">Any</option>
            {tags.map((t) => (
              <option key={t.id} value={t.id}>
                #{t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-3">
          Collection
          <select value={collectionId} onChange={(e) => setCollectionId(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-2 py-2 text-sm text-ink">
            <option value="">Any</option>
            {collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-ink-3">
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-2 py-1.5 text-sm text-ink" />
        </label>
        <label className="text-xs text-ink-3">
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-panel px-2 py-1.5 text-sm text-ink" />
        </label>
      </div>

      <div className="mt-5 space-y-3 pl-10" aria-live="polite">
        {offline ? <p className="text-sm text-warn">You are offline. Showing matches from items saved on this device.</p> : null}
        {!hasFilter ? <p className="-ml-10 text-sm text-ink-3">Type to search. Spelling mistakes are fine; filters narrow the results.</p> : null}
        {busy && !shown ? <p className="text-sm text-ink-3">Searching…</p> : null}
        {shown && !shown.length ? <p className="-ml-10 text-sm text-ink-2">Nothing found. Try fewer words or remove a filter.</p> : null}
        {shown?.map((r) => (
          <ItemCard key={r.item.id} item={r.item} onAction={onAction} highlight={r.highlight && r.highlight.includes("<mark>") ? <Highlight text={r.highlight} /> : undefined} />
        ))}
        {hasFilter && nextOffset != null ? (
          <div className="-ml-10 flex justify-center">
            <button onClick={() => run(nextOffset)} className="rounded-xl border border-line px-4 py-2 text-sm">
              More results
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
