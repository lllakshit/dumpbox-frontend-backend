"use client"
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { api, ApiFailure, uploadFile } from "@/lib/client/api"
import { feedCache, outbox, type Pending } from "@/lib/client/outbox"
import { browserSupabase, liveSupabase } from "@/lib/client/supabase"
import { inView, TYPE_LABEL, viewQuery, viewTitle, type Collection, type Item, type ItemType, type Tag, type View } from "@/lib/client/types"
import { CollectionsPanel } from "./CollectionsPanel"
import { classifyText, Composer, type Capture } from "./Composer"
import { CollectionDialog, ConfirmDialog, EditDialog, HistoryDialog, ShareDialog, TagDialog } from "./dialogs"
import { Icon } from "./icons"
import { ItemCard, type ItemAction, type PendingState } from "./ItemCard"
import { SearchPanel } from "./SearchPanel"
import { SettingsPanel } from "./SettingsPanel"
import { dayLabel, Modal, Button, Toasts, type Toast } from "./ui"
import { clearPlannerCache, usePlanner } from "@/lib/client/planner"
import { CalendarView } from "../planner/CalendarView"
import { EntryEditor, type EditorTarget } from "../planner/EntryEditor"
import { ImportDialog } from "../planner/ImportDialog"
import { PlannerSettings } from "../planner/PlannerSettings"
import { quickBody } from "../planner/QuickAdd"
import { TasksView } from "../planner/TasksView"

type Panel = "feed" | "search" | "collections" | "settings" | "calendar" | "tasks"
const PANEL_KEY = "dumpbox.panel"
type Local = { item: Item; state: PendingState; error?: string; files?: File[] }
type DialogState =
  | { kind: "tags"; item: Item }
  | { kind: "bulk-tags"; ids: string[] }
  | { kind: "collections"; item: Item }
  | { kind: "bulk-collection"; ids: string[] }
  | { kind: "share"; target: { item_id?: string; collection_id?: string; label: string } }
  | { kind: "edit"; item: Item }
  | { kind: "history"; item: Item }
  | { kind: "confirm"; title: string; text: string; label: string; danger?: boolean; run: () => Promise<void> }
  | { kind: "rename"; title: string; value: string; run: (v: string) => Promise<void> }
  | { kind: "delete-account" }
  | null

const SMART: { type: ItemType; icon: keyof typeof Icon }[] = [
  { type: "note", icon: "note" },
  { type: "link", icon: "link" },
  { type: "image", icon: "image" },
  { type: "file", icon: "file" },
  { type: "location", icon: "place" },
  { type: "voice", icon: "voice" },
]

function sortNewest(a: Item, b: Item) {
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)
}

function draft(id: string, payload: Record<string, unknown>): Item {
  const now = (payload.captured_at as string) ?? new Date().toISOString()
  return {
    id,
    type: payload.type as ItemType,
    title: (payload.title as string) ?? null,
    body: (payload.body as string) ?? null,
    source: "web",
    url: (payload.url as string) ?? null,
    link: payload.url ? { title: null, description: null, image_url: null, site: null } : null,
    location:
      payload.latitude != null ? { latitude: payload.latitude as number, longitude: payload.longitude as number, label: (payload.location_label as string) || null } : null,
    pinned: false,
    starred: false,
    archived_at: null,
    deleted_at: null,
    version: 0,
    created_at: now,
    updated_at: now,
    tags: [],
    collection_ids: [],
    files: [],
  }
}

export function DumpBoxApp() {
  const router = useRouter()
  const [userId, setUserId] = useState<string | null>(null)
  const [authChecked, setAuthChecked] = useState(false)
  const [panel, setPanel] = useState<Panel>("feed")
  const [view, setView] = useState<View>({ kind: "feed" })
  const [items, setItems] = useState<Item[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [locals, setLocals] = useState<Local[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [collections, setCollections] = useState<Collection[]>([])
  const [online, setOnline] = useState(true)
  const [dialog, setDialog] = useState<DialogState>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [navOpen, setNavOpen] = useState(false)
  const [searchKey, setSearchKey] = useState(0)
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const viewRef = useRef(view)
  viewRef.current = view
  const syncToken = useRef<string | null>(null)
  const syncing = useRef(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const loadSeq = useRef(0)

  const notify = useCallback((text: string, tone?: "ok" | "error", action?: Toast["action"]) => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-2), { id, text, tone, action }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 7000 : 3500)
  }, [])

  const planner = usePlanner(userId, notify)

  // Reopen on the last section used (calendar and tasks are often the place to come back to).
  useEffect(() => {
    try {
      const p = localStorage.getItem(PANEL_KEY)
      if (p === "calendar" || p === "tasks") setPanel(p)
    } catch {
      // ignore
    }
  }, [])
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, panel)
    } catch {
      // ignore
    }
  }, [panel])

  // ---------- auth ----------
  useEffect(() => {
    const sb = browserSupabase()
    sb.auth.getSession().then(({ data }) => {
      if (!data.session) router.replace("/login")
      else setUserId(data.session.user.id)
      setAuthChecked(true)
    })
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        router.replace("/login")
      } else {
        setUserId(session.user.id)
        liveSupabase().realtime.setAuth(session.access_token)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [router])

  // ---------- lists ----------
  const refreshLists = useCallback(async () => {
    const [t, c] = await Promise.allSettled([api.tags(), api.collections()])
    if (t.status === "fulfilled") setTags(t.value.tags)
    if (c.status === "fulfilled") setCollections(c.value.collections)
  }, [])

  // ---------- feed loading ----------
  const loadView = useCallback(async (v: View) => {
    const mine = ++loadSeq.current
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api.listItems(viewQuery(v))
      if (mine !== loadSeq.current) return
      setItems(r.items)
      setCursor(r.next_cursor)
      if (v.kind === "feed") feedCache.save(r.items)
    } catch (e) {
      if (mine !== loadSeq.current) return
      if (e instanceof ApiFailure && e.offline) {
        setItems(feedCache.load<Item>().filter((i) => inView(i, v)))
        setCursor(null)
      } else {
        setLoadError(e instanceof Error ? e.message : "Could not load")
      }
    } finally {
      if (mine === loadSeq.current) setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!cursor || loading) return
    const mine = loadSeq.current
    try {
      const r = await api.listItems(viewQuery(viewRef.current), cursor)
      if (mine !== loadSeq.current) return
      setItems((cur) => {
        const seen = new Set(cur.map((i) => i.id))
        return [...cur, ...r.items.filter((i) => !seen.has(i.id))]
      })
      setCursor(r.next_cursor)
    } catch {
      // the sentinel retries on the next scroll
    }
  }, [cursor, loading])

  useEffect(() => {
    if (!userId) return
    loadView(view)
  }, [userId, view, loadView])

  useEffect(() => {
    if (!userId) return
    refreshLists()
  }, [userId, refreshLists])

  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && loadMore(), { rootMargin: "600px" })
    io.observe(el)
    return () => io.disconnect()
  }, [loadMore, items.length])

  // ---------- applying server items ----------
  const applyItems = useCallback((incoming: Item[], removedIds: string[] = []) => {
    if (!incoming.length && !removedIds.length) return
    const removed = new Set(removedIds)
    setItems((cur) => {
      const map = new Map(cur.map((i) => [i.id, i]))
      for (const it of incoming) {
        const have = map.get(it.id)
        if (have && have.version > it.version) continue
        if (inView(it, viewRef.current)) map.set(it.id, it)
        else map.delete(it.id)
      }
      for (const id of removed) map.delete(id)
      const next = [...map.values()].sort(sortNewest)
      if (viewRef.current.kind === "feed") feedCache.save(next)
      return next
    })
    setLocals((cur) => cur.filter((l) => !incoming.some((i) => i.id === l.item.id && l.state !== "failed")))
  }, [])

  // ---------- sync: realtime nudge + /v1/changes pull ----------
  const pull = useCallback(async () => {
    if (syncing.current) return
    syncing.current = true
    try {
      if (!syncToken.current) {
        const r = await api.changes(null)
        syncToken.current = r.next_since
        return
      }
      for (let i = 0; i < 20; i++) {
        const r = await api.changes(syncToken.current)
        if (r.reset) {
          syncToken.current = null
          await loadView(viewRef.current)
          return
        }
        applyItems(r.items, r.deleted_ids)
        syncToken.current = r.next_since
        if (!r.has_more) break
      }
    } catch {
      // offline or transient; the next nudge retries
    } finally {
      syncing.current = false
    }
  }, [applyItems, loadView])

  useEffect(() => {
    if (!userId) return
    pull()
    let timer: ReturnType<typeof setTimeout> | null = null
    const nudge = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        pull()
        refreshLists()
      }, 250)
    }
    // Instant updates when the direct realtime connection works; otherwise check every 15 s while the tab is visible.
    let live = false
    const live$ = liveSupabase()
    let channel: ReturnType<typeof live$.channel> | null = null
    browserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) return
        live$.realtime.setAuth(data.session.access_token)
        channel = live$
          .channel(`items:${userId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: `user_id=eq.${userId}` }, nudge)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "item_tombstones", filter: `user_id=eq.${userId}` }, nudge)
          .subscribe((status) => {
            live = status === "SUBSCRIBED"
          })
      })
    const onFocus = () => nudge()
    window.addEventListener("focus", onFocus)
    let ticks = 0
    const interval = setInterval(() => {
      ticks++
      if (document.visibilityState !== "visible") return
      if (!live || ticks % 4 === 0) nudge()
    }, 15_000)
    return () => {
      window.removeEventListener("focus", onFocus)
      clearInterval(interval)
      if (timer) clearTimeout(timer)
      if (channel) live$.removeChannel(channel)
    }
  }, [userId, pull, refreshLists])

  // ---------- offline queue ----------
  const flushOutbox = useCallback(async () => {
    for (const p of outbox.all()) {
      try {
        const { item } = await api.createItem(p.payload)
        outbox.remove(p.id)
        applyItems([item])
        setLocals((cur) => cur.filter((l) => l.item.id !== p.id))
      } catch (e) {
        // Keep it for later on network trouble, an expired session, rate limits and server errors.
        if (e instanceof ApiFailure && (e.offline || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500)) return
        if (!(e instanceof ApiFailure)) return
        outbox.update(p.id, { attempts: p.attempts + 1, error: e instanceof Error ? e.message : "failed" })
        setLocals((cur) => cur.map((l) => (l.item.id === p.id ? { ...l, state: "failed", error: e instanceof Error ? e.message : undefined } : l)))
        outbox.remove(p.id)
      }
    }
  }, [applyItems])

  useEffect(() => {
    if (!userId) return
    const queued = outbox.all()
    if (queued.length) setLocals((cur) => [...cur, ...queued.filter((p) => !cur.some((l) => l.item.id === p.id)).map((p) => ({ item: draft(p.id, p.payload), state: "queued" as const }))])
    setOnline(navigator.onLine)
    if (navigator.onLine) flushOutbox()
    const on = () => {
      setOnline(true)
      flushOutbox()
      pull()
    }
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [userId, flushOutbox, pull])

  // ---------- capture ----------
  const sendPayload = useCallback(
    async (payload: Record<string, unknown>) => {
      const id = payload.id as string
      setLocals((cur) => [...cur.filter((l) => l.item.id !== id), { item: draft(id, payload), state: "sending" }])
      if (!navigator.onLine) {
        outbox.add({ id, payload, queuedAt: new Date().toISOString(), attempts: 0 })
        setLocals((cur) => cur.map((l) => (l.item.id === id ? { ...l, state: "queued" } : l)))
        return
      }
      try {
        const { item } = await api.createItem(payload)
        applyItems([item])
        setLocals((cur) => cur.filter((l) => l.item.id !== id))
      } catch (e) {
        if (e instanceof ApiFailure && e.offline) {
          outbox.add({ id, payload, queuedAt: new Date().toISOString(), attempts: 0 })
          setLocals((cur) => cur.map((l) => (l.item.id === id ? { ...l, state: "queued" } : l)))
        } else {
          setLocals((cur) => cur.map((l) => (l.item.id === id ? { ...l, state: "failed", error: e instanceof Error ? e.message : undefined } : l)))
        }
      }
    },
    [applyItems],
  )

  const contextExtras = useCallback((): Record<string, unknown> => {
    const v = viewRef.current
    // Capturing inside a tag or collection view files the item there.
    if (v.kind === "tag") return { tags: [v.name] }
    if (v.kind === "collection") return { collection_ids: [v.id] }
    return {}
  }, [])

  const sendFiles = useCallback(
    async (files: File[], caption: string) => {
      if (!navigator.onLine) {
        notify("Files need a connection. Try again when you are online.", "error")
        return
      }
      for (const [idx, file] of files.entries()) {
        const id = crypto.randomUUID()
        const mime = file.type || "application/octet-stream"
        const type: ItemType = mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "voice" : "file"
        const payload = { id, type, title: null, body: idx === 0 && caption ? caption : null, source: "web", ...contextExtras() }
        setLocals((cur) => [...cur, { item: { ...draft(id, payload), files: [] }, state: "sending", files: [file] }])
        try {
          await api.createItem(payload)
          const { item, duplicateOf } = await uploadFile(id, file)
          applyItems([item])
          setLocals((cur) => cur.filter((l) => l.item.id !== id))
          if (duplicateOf) {
            notify(`“${file.name}” was already in your DumpBox.`, undefined, {
              label: "Remove this copy",
              run: async () => {
                await api.deleteForever(id).catch(() => {})
                applyItems([], [id])
              },
            })
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : "Upload failed"
          setLocals((cur) => cur.map((l) => (l.item.id === id ? { ...l, state: "failed", error: msg } : l)))
          // Do not leave an empty file item behind.
          await api.deleteForever(id).catch(() => {})
        }
      }
    },
    [applyItems, contextExtras, notify],
  )

  const onCapture = useCallback(
    (c: Capture) => {
      if (c.kind === "files") {
        sendFiles(c.files, c.caption)
        return
      }
      const id = crypto.randomUUID()
      const base = { id, source: "web", captured_at: new Date().toISOString(), ...contextExtras() }
      if (c.kind === "place") {
        sendPayload({ ...base, type: "location", latitude: c.latitude, longitude: c.longitude, location_label: c.label || null })
        return
      }
      const kind = classifyText(c.text)
      sendPayload(kind.type === "link" ? { ...base, type: "link", url: kind.url } : { ...base, type: "note", body: c.text })
      if (panel !== "feed") setPanel("feed")
    },
    [contextExtras, panel, sendFiles, sendPayload],
  )

  const retry = useCallback(
    (l: Local) => {
      if (l.files?.length) {
        setLocals((cur) => cur.filter((x) => x.item.id !== l.item.id))
        sendFiles(l.files, l.item.body ?? "")
        return
      }
      const it = l.item
      sendPayload({
        id: it.id,
        type: it.type,
        body: it.body,
        url: it.url,
        latitude: it.location?.latitude,
        longitude: it.location?.longitude,
        location_label: it.location?.label,
        source: "web",
        captured_at: it.created_at,
      })
    },
    [sendFiles, sendPayload],
  )

  // ---------- item actions ----------
  const mutate = useCallback(
    async (fn: () => Promise<{ item: Item }>, okText?: string) => {
      try {
        const { item } = await fn()
        applyItems([item])
        if (okText) notify(okText)
        setSearchKey((k) => k + 1)
        return item
      } catch (e) {
        notify(e instanceof ApiFailure ? (e.offline ? "You are offline. Try again when connected." : e.message) : "Something went wrong", "error")
        return null
      }
    },
    [applyItems, notify],
  )

  const onAction = useCallback(
    (a: ItemAction, item: Item) => {
      switch (a) {
        case "star":
          mutate(() => api.updateItem(item.id, { starred: !item.starred, base_version: item.version }))
          break
        case "pin":
          mutate(() => api.updateItem(item.id, { pinned: !item.pinned, base_version: item.version }))
          break
        case "archive":
          mutate(() => api.updateItem(item.id, { archived: !item.archived_at, base_version: item.version }), item.archived_at ? "Moved back to the feed" : "Archived. Still searchable.")
          break
        case "trash":
          mutate(() => api.trashItem(item.id)).then((r) => {
            if (r)
              notify("Moved to trash", undefined, {
                label: "Undo",
                run: () => mutate(() => api.restoreItem(item.id)),
              })
          })
          break
        case "restore":
          mutate(() => api.restoreItem(item.id), "Restored")
          break
        case "forever":
          setDialog({
            kind: "confirm",
            title: "Delete forever?",
            text: "This item and its files will be removed for good. This cannot be undone.",
            label: "Delete forever",
            danger: true,
            run: async () => {
              try {
                await api.deleteForever(item.id)
                applyItems([], [item.id])
                setDialog(null)
              } catch {
                notify("Could not delete", "error")
              }
            },
          })
          break
        case "copy": {
          const text = [item.title, item.body, item.url, item.location ? `${item.location.latitude},${item.location.longitude}` : null].filter(Boolean).join("\n")
          navigator.clipboard.writeText(text).then(
            () => notify("Copied"),
            () => notify("Could not copy", "error"),
          )
          break
        }
        case "tags":
          setDialog({ kind: "tags", item })
          break
        case "collections":
          setDialog({ kind: "collections", item })
          break
        case "share":
          setDialog({ kind: "share", target: { item_id: item.id, label: "item" } })
          break
        case "edit":
          setDialog({ kind: "edit", item })
          break
        case "history":
          setDialog({ kind: "history", item })
          break
        case "event":
        case "task": {
          // Turn the item into an event or task: its text is read like quick add ("call bank friday 11am").
          const full = [item.title, item.body, item.link?.title, item.url].filter(Boolean).join("\n").trim()
          const first = (item.title || item.body || item.link?.title || item.url || item.location?.label || TYPE_LABEL[item.type]).split("\n")[0].slice(0, 300)
          const { body } = quickBody(planner, first, a)
          const rest = full.split("\n").slice(item.title ? 0 : 1).join("\n").trim()
          setEditor({
            draft: {
              ...(body as object),
              kind: (body.kind as "event" | "task") ?? a,
              notes: rest || null,
              location: (body.location as string) ?? item.location?.label ?? null,
              source_item_id: item.id,
            },
          })
          break
        }
      }
    },
    [applyItems, mutate, notify, planner],
  )

  // ---------- bulk ----------
  const bulk = useCallback(
    async (action: string, extra: Record<string, unknown> = {}, okText?: string) => {
      const ids = [...selected]
      if (!ids.length) return
      try {
        const r = await api.bulk(ids, action, extra)
        applyItems(r.items)
        notify(okText ?? `${r.affected} updated`)
        setSelected(new Set())
        setSelecting(false)
        refreshLists()
      } catch (e) {
        notify(e instanceof ApiFailure ? e.message : "Could not update", "error")
      }
    },
    [applyItems, notify, refreshLists, selected],
  )

  // ---------- navigation ----------
  const go = useCallback((v: View) => {
    setView(v)
    setPanel("feed")
    setNavOpen(false)
    setSelecting(false)
    setSelected(new Set())
  }, [])

  const signOut = useCallback(async () => {
    feedCache.clear()
    clearPlannerCache()
    await browserSupabase().auth.signOut()
    router.replace("/login")
  }, [router])

  // ---------- render helpers ----------
  const visibleLocals = useMemo(() => locals.filter((l) => panel === "feed" && (view.kind === "feed" || inView(l.item, view) || l.state !== "sending")), [locals, panel, view])

  const feedRows = useMemo(() => {
    // Newest first in data; the list is drawn bottom-up (column-reverse), like a chat.
    const all: { item: Item; local?: Local }[] = [
      ...visibleLocals.map((l) => ({ item: l.item, local: l })),
      ...items.filter((i) => !visibleLocals.some((l) => l.item.id === i.id)).map((item) => ({ item })),
    ].sort((a, b) => sortNewest(a.item, b.item))
    const rows: ReactNode[] = []
    all.forEach((row, i) => {
      rows.push(
        <ItemCard
          key={row.item.id}
          item={row.item}
          pending={row.local ? { state: row.local.state, error: row.local.error } : undefined}
          onRetry={row.local ? () => retry(row.local!) : undefined}
          onAction={onAction}
          selectable={selecting && !row.local}
          selected={selected.has(row.item.id)}
          onToggleSelect={() =>
            setSelected((s) => {
              const n = new Set(s)
              if (n.has(row.item.id)) n.delete(row.item.id)
              else n.add(row.item.id)
              return n
            })
          }
        />,
      )
      const next = all[i + 1]
      if (!next || new Date(next.item.created_at).toDateString() !== new Date(row.item.created_at).toDateString()) {
        rows.push(
          <div key={`day-${row.item.id}`} className="sticky top-0 z-10 flex justify-center py-1" role="separator">
            <span className="rounded-full border border-line bg-panel px-3 py-0.5 text-xs text-ink-3">{dayLabel(row.item.created_at)}</span>
          </div>,
        )
      }
    })
    return rows
  }, [items, onAction, retry, selected, selecting, visibleLocals])

  if (!authChecked || !userId) {
    return <div className="grid h-full place-items-center text-ink-3">Loading…</div>
  }

  const navButton = (label: string, active: boolean, onClick: () => void, icon: ReactNode, count?: number) => (
    <button onClick={onClick} aria-current={active ? "page" : undefined} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm ${active ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-panel-2"}`}>
      {icon}
      <span className="flex-1 truncate">{label}</span>
      {count != null ? <span className="text-xs text-ink-3">{count}</span> : null}
    </button>
  )
  const isView = (v: View) => panel === "feed" && JSON.stringify(v) === JSON.stringify(view)

  const sidebar = (
    <nav aria-label="Main" className="scroll-thin flex h-full flex-col gap-5 overflow-y-auto p-3">
      <div className="flex items-center gap-2 px-2 pt-1">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-accent font-bold text-accent-ink">D</div>
        <span className="font-semibold">DumpBox</span>
      </div>
      <div className="space-y-0.5">
        {navButton("Feed", isView({ kind: "feed" }), () => go({ kind: "feed" }), <Icon.feed />)}
        {navButton("Search", panel === "search", () => { setPanel("search"); setNavOpen(false) }, <Icon.search />)}
        {navButton("Calendar", panel === "calendar", () => { setPanel("calendar"); setNavOpen(false) }, <Icon.calendar />)}
        {navButton("Tasks", panel === "tasks", () => { setPanel("tasks"); setNavOpen(false) }, <Icon.task />, planner.entries.filter((e) => e.kind === "task" && !e.completed_at && !e.parent_id).length || undefined)}
        {navButton("Pinned", isView({ kind: "pinned" }), () => go({ kind: "pinned" }), <Icon.pin />)}
        {navButton("Starred", isView({ kind: "starred" }), () => go({ kind: "starred" }), <Icon.star />)}
      </div>
      <div>
        <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Smart views</p>
        <div className="space-y-0.5">
          {SMART.map((s) => {
            const I = Icon[s.icon]
            return <div key={s.type}>{navButton(TYPE_LABEL[s.type], isView({ kind: "type", type: s.type }), () => go({ kind: "type", type: s.type }), <I />)}</div>
          })}
        </div>
      </div>
      <div>
        <div className="flex items-center justify-between px-3 pb-1">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-3">Collections</p>
          <button onClick={() => { setPanel("collections"); setNavOpen(false) }} className="text-xs text-accent">
            Manage
          </button>
        </div>
        <div className="space-y-0.5">
          {collections.slice(0, 12).map((c) => (
            <div key={c.id}>{navButton(c.name, isView({ kind: "collection", id: c.id, name: c.name }), () => go({ kind: "collection", id: c.id, name: c.name }), <Icon.folder />, c.item_count)}</div>
          ))}
          {!collections.length ? <p className="px-3 text-xs text-ink-3">None yet</p> : null}
        </div>
      </div>
      <div>
        <p className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-ink-3">Tags</p>
        <div className="flex flex-wrap gap-1.5 px-2">
          {tags.slice(0, 30).map((t) => (
            <button key={t.id} onClick={() => go({ kind: "tag", id: t.id, name: t.name })} className={`rounded-full border px-2 py-0.5 text-xs ${isView({ kind: "tag", id: t.id, name: t.name }) ? "border-accent bg-accent-soft text-accent" : "border-line text-ink-2"}`}>
              #{t.name}
            </button>
          ))}
          {!tags.length ? <p className="px-1 text-xs text-ink-3">None yet</p> : null}
        </div>
      </div>
      <div className="mt-auto space-y-0.5 border-t border-line pt-3">
        {navButton("Archive", isView({ kind: "archived" }), () => go({ kind: "archived" }), <Icon.archive />)}
        {navButton("Trash", isView({ kind: "trash" }), () => go({ kind: "trash" }), <Icon.trash />)}
        {navButton("Settings", panel === "settings", () => { setPanel("settings"); setNavOpen(false) }, <Icon.settings />)}
      </div>
    </nav>
  )

  const title =
    panel === "feed" ? viewTitle(view) : panel === "search" ? "Search" : panel === "collections" ? "Collections & tags" : panel === "calendar" ? "Calendar" : panel === "tasks" ? "Tasks" : "Settings"
  const emptyText =
    view.kind === "trash" ? "Trash is empty. Deleted items stay here for 30 days." : view.kind === "archived" ? "Nothing archived." : view.kind === "feed" ? "Your DumpBox is empty. Type below, paste a link, or drop a file to start." : "Nothing here yet."

  return (
    <div className="flex h-dvh overflow-hidden">
      <aside className="hidden w-64 shrink-0 border-r border-line bg-panel md:block">{sidebar}</aside>
      {navOpen ? (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
          <div className="absolute inset-0 bg-black/40" onClick={() => setNavOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-panel shadow-[var(--shadow)]">{sidebar}</aside>
        </div>
      ) : null}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-line bg-panel/95 px-3 py-2.5 backdrop-blur md:px-6">
          <button className="rounded-lg p-1.5 text-ink-2 md:hidden" onClick={() => setNavOpen(true)} aria-label="Open menu">
            <Icon.menu />
          </button>
          <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h1>
          {!online ? (
            <span className="flex items-center gap-1 rounded-full bg-panel-2 px-2.5 py-1 text-xs text-warn">
              <Icon.cloudOff width={14} height={14} /> Offline
            </span>
          ) : null}
          {panel === "feed" && view.kind === "collection" ? (
            <button className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2" aria-label="Share collection" onClick={() => setDialog({ kind: "share", target: { collection_id: view.id, label: `“${view.name}”` } })}>
              <Icon.share />
            </button>
          ) : null}
          {panel === "feed" ? (
            <button
              onClick={() => {
                setSelecting((s) => !s)
                setSelected(new Set())
              }}
              className={`rounded-lg p-1.5 ${selecting ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-panel-2"}`}
              aria-pressed={selecting}
              aria-label="Select items"
              title="Select items"
            >
              <Icon.select />
            </button>
          ) : null}
          {panel === "calendar" || panel === "tasks" ? (
            <button onClick={() => setImportOpen(true)} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-2 hover:bg-panel-2" aria-label="Import or export" title="Import / export (JSON, .ics)">
              <Icon.upload /> <span className="hidden sm:inline">Import</span>
            </button>
          ) : null}
          <button onClick={() => setPanel("search")} className="rounded-lg p-1.5 text-ink-2 hover:bg-panel-2 md:hidden" aria-label="Search">
            <Icon.search />
          </button>
        </header>

        {selecting && panel === "feed" ? (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-accent-soft px-3 py-2 text-sm md:px-6">
            <span className="font-medium">{selected.size} selected</span>
            <span className="flex-1" />
            {view.kind === "trash" ? (
              <>
                <Button onClick={() => bulk("restore", {}, "Restored")} disabled={!selected.size}>Restore</Button>
              </>
            ) : (
              <>
                <Button onClick={() => bulk("star")} disabled={!selected.size}>Star</Button>
                <Button onClick={() => setDialog({ kind: "bulk-tags", ids: [...selected] })} disabled={!selected.size}>Tag</Button>
                <Button onClick={() => setDialog({ kind: "bulk-collection", ids: [...selected] })} disabled={!selected.size}>Add to collection</Button>
                <Button onClick={() => bulk(view.kind === "archived" ? "unarchive" : "archive")} disabled={!selected.size}>
                  {view.kind === "archived" ? "Unarchive" : "Archive"}
                </Button>
                <Button kind="danger" onClick={() => bulk("delete", {}, "Moved to trash")} disabled={!selected.size}>Trash</Button>
              </>
            )}
          </div>
        ) : null}

        {/* In the feed the scroll box itself is column-reverse, so it opens at the newest item and stays there, like a chat. */}
        <div className={`min-h-0 flex-1 scroll-thin ${panel === "calendar" || panel === "tasks" ? "overflow-hidden" : "overflow-y-auto"} ${panel === "feed" ? "flex flex-col-reverse" : ""}`}>
          {panel === "calendar" ? <CalendarView planner={planner} onOpen={setEditor} /> : null}
          {panel === "tasks" ? <TasksView planner={planner} onOpen={setEditor} /> : null}
          {panel === "feed" ? (
            <div className="flex flex-col-reverse gap-3 px-3 py-4 pl-12 md:px-6 md:pl-16">
              {feedRows}
              {loading && !items.length ? <p className="text-center text-sm text-ink-3">Loading…</p> : null}
              {loadError ? (
                <div className="text-center text-sm text-danger">
                  {loadError}{" "}
                  <button className="underline" onClick={() => loadView(view)}>
                    Try again
                  </button>
                </div>
              ) : null}
              {!loading && !loadError && !feedRows.length ? <p className="mx-auto max-w-sm py-16 text-center text-ink-2">{emptyText}</p> : null}
              <div ref={sentinel} className="h-1" aria-hidden="true" />
              {cursor ? <p className="text-center text-xs text-ink-3">Loading older…</p> : null}
            </div>
          ) : null}
          {panel === "search" ? <SearchPanel tags={tags} collections={collections} onAction={onAction} refreshKey={searchKey} /> : null}
          {panel === "collections" ? (
            <CollectionsPanel
              collections={collections}
              tags={tags}
              onOpenCollection={(c) => go({ kind: "collection", id: c.id, name: c.name })}
              onOpenTag={(t) => go({ kind: "tag", id: t.id, name: t.name })}
              onCreate={async (name) => {
                try {
                  await api.createCollection(name)
                  refreshLists()
                } catch (e) {
                  notify(e instanceof ApiFailure && e.code === "conflict" ? "A collection with that name exists" : "Could not create", "error")
                }
              }}
              onShare={(c) => setDialog({ kind: "share", target: { collection_id: c.id, label: `“${c.name}”` } })}
              onRename={(c) =>
                setDialog({
                  kind: "rename",
                  title: "Rename collection",
                  value: c.name,
                  run: async (v) => {
                    await api.renameCollection(c.id, v)
                    refreshLists()
                  },
                })
              }
              onDelete={(c) =>
                setDialog({
                  kind: "confirm",
                  title: `Delete “${c.name}”?`,
                  text: "The collection is removed. Its items stay in your feed.",
                  label: "Delete collection",
                  danger: true,
                  run: async () => {
                    await api.deleteCollection(c.id)
                    refreshLists()
                    if (view.kind === "collection" && view.id === c.id) go({ kind: "feed" })
                    setDialog(null)
                  },
                })
              }
              onRenameTag={(t) =>
                setDialog({
                  kind: "rename",
                  title: "Rename tag",
                  value: t.name,
                  run: async (v) => {
                    await api.renameTag(t.id, v)
                    refreshLists()
                    pull()
                  },
                })
              }
              onDeleteTag={(t) =>
                setDialog({
                  kind: "confirm",
                  title: `Delete #${t.name}?`,
                  text: "The tag is removed from every item. The items stay.",
                  label: "Delete tag",
                  danger: true,
                  run: async () => {
                    await api.deleteTag(t.id)
                    refreshLists()
                    pull()
                    setDialog(null)
                  },
                })
              }
            />
          ) : null}
          {panel === "settings" ? (
            <>
              <SettingsPanel notify={notify} onSignOut={signOut} onDeleteAccount={() => setDialog({ kind: "delete-account" })} />
              <PlannerSettings planner={planner} onImport={() => setImportOpen(true)} />
            </>
          ) : null}
        </div>

        {panel === "feed" && view.kind !== "trash" ? <Composer onCapture={onCapture} /> : null}

        <nav className="flex border-t border-line bg-panel md:hidden" aria-label="Sections">
          {(
            [
              ["feed", "Feed", <Icon.feed key="f" />],
              ["calendar", "Calendar", <Icon.calendar key="cal" />],
              ["tasks", "Tasks", <Icon.task key="t" />],
              ["search", "Search", <Icon.search key="s" />],
              ["collections", "Collections", <Icon.folder key="c" />],
              ["settings", "Settings", <Icon.settings key="g" />],
            ] as [Panel, string, ReactNode][]
          ).map(([p, label, icon]) => (
            <button
              key={p}
              onClick={() => (p === "feed" ? go({ kind: "feed" }) : setPanel(p))}
              aria-current={panel === p ? "page" : undefined}
              className={`flex min-w-0 flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${panel === p ? "text-accent" : "text-ink-3"}`}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
      </main>

      {dialog?.kind === "tags" ? (
        <TagDialog
          initial={dialog.item.tags.map((t) => t.name)}
          allTags={tags}
          onClose={() => setDialog(null)}
          onSave={async (names) => {
            const r = await mutate(() => api.setTags(dialog.item.id, names))
            if (r) {
              setDialog(null)
              refreshLists()
            }
          }}
        />
      ) : null}
      {dialog?.kind === "bulk-tags" ? (
        <TagDialog
          title={`Add tags to ${dialog.ids.length} items`}
          initial={[]}
          allTags={tags}
          onClose={() => setDialog(null)}
          onSave={async (names) => {
            if (names.length) await bulk("add_tags", { tags: names }, "Tags added")
            setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "collections" ? (
        <CollectionDialog
          item={dialog.item}
          collections={collections}
          onClose={() => setDialog(null)}
          onCreate={async (name) => {
            try {
              const r = await api.createCollection(name)
              setCollections((cur) => [...cur, r.collection].sort((a, b) => a.name.localeCompare(b.name)))
              return r.collection
            } catch (e) {
              notify(e instanceof ApiFailure && e.code === "conflict" ? "A collection with that name exists" : "Could not create", "error")
              return null
            }
          }}
          onSave={async (ids) => {
            const r = await mutate(() => api.setCollections(dialog.item.id, ids))
            if (r) {
              setDialog(null)
              refreshLists()
            }
          }}
        />
      ) : null}
      {dialog?.kind === "bulk-collection" ? (
        <Modal title={`Add ${dialog.ids.length} items to…`} onClose={() => setDialog(null)}>
          <ul className="space-y-1">
            {collections.map((c) => (
              <li key={c.id}>
                <button
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left hover:bg-panel-2"
                  onClick={async () => {
                    await bulk("add_to_collection", { collection_id: c.id }, `Added to ${c.name}`)
                    setDialog(null)
                  }}
                >
                  <Icon.folder /> {c.name}
                </button>
              </li>
            ))}
            {!collections.length ? <li className="text-sm text-ink-3">Create a collection first (Collections page).</li> : null}
          </ul>
        </Modal>
      ) : null}
      {dialog?.kind === "share" ? <ShareDialog target={dialog.target} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "edit" ? (
        <EditDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSave={async (patch) => {
            const r = await mutate(() => api.updateItem(dialog.item.id, { ...patch, base_version: dialog.item.version }))
            if (r) setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "history" ? (
        <HistoryDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onRestore={async (v) => {
            const r = await mutate(() => api.updateItem(dialog.item.id, { title: v.title, body: v.body }), "Version restored")
            if (r) setDialog(null)
          }}
        />
      ) : null}
      {dialog?.kind === "confirm" ? <ConfirmDialog title={dialog.title} text={dialog.text} confirmLabel={dialog.label} danger={dialog.danger} onConfirm={dialog.run} onClose={() => setDialog(null)} /> : null}
      {dialog?.kind === "rename" ? <RenameDialog title={dialog.title} value={dialog.value} onClose={() => setDialog(null)} onSave={dialog.run} notify={notify} /> : null}
      {dialog?.kind === "delete-account" ? <DeleteAccountDialog onClose={() => setDialog(null)} onDeleted={signOut} /> : null}

      {editor ? <EntryEditor key={editor.entry?.id ?? "new"} target={editor} planner={planner} onClose={() => setEditor(null)} /> : null}
      {importOpen ? <ImportDialog planner={planner} onClose={() => setImportOpen(false)} /> : null}

      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  )
}

function RenameDialog({ title, value, onSave, onClose, notify }: { title: string; value: string; onSave: (v: string) => Promise<void>; onClose: () => void; notify: (t: string, tone?: "ok" | "error") => void }) {
  const [v, setV] = useState(value)
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!v.trim()) return
          setBusy(true)
          try {
            await onSave(v.trim())
            onClose()
          } catch (err) {
            notify(err instanceof ApiFailure && err.code === "conflict" ? "That name is taken" : "Could not rename", "error")
          } finally {
            setBusy(false)
          }
        }}
      >
        <label htmlFor="rename" className="sr-only">
          New name
        </label>
        <input id="rename" value={v} onChange={(e) => setV(e.target.value)} maxLength={80} className="w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" kind="primary" disabled={busy || !v.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}

function DeleteAccountDialog({ onClose, onDeleted }: { onClose: () => void; onDeleted: () => void }) {
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <Modal title="Delete your account?" onClose={onClose}>
      <p className="text-sm text-ink-2">Every item, file, tag, collection and share link is removed for good. Export your data first if you want a copy.</p>
      <label htmlFor="confirm-delete" className="mt-4 block text-sm font-medium">
        Type DELETE to confirm
      </label>
      <input id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-danger" autoComplete="off" />
      {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          kind="danger"
          disabled={typed !== "DELETE" || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.deleteMe()
              onDeleted()
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not delete the account")
              setBusy(false)
            }
          }}
        >
          Delete everything
        </Button>
      </div>
    </Modal>
  )
}

export type { Pending }
