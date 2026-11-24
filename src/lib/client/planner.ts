"use client"
/**
 * Planner on the web: keeps every event and task of the account in memory (and in this browser for offline
 * viewing), synced with /v1/planner/changes. Changes are shown at once and rolled back if the server refuses them.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { call, ApiFailure } from "./api"
import { browserSupabase, liveSupabase } from "./supabase"
import { DEFAULT_PREFS, type Entry, type PlannerList, type PlannerPrefs } from "@/lib/planner/types"
import { remindersBetween, reminderBody } from "@/lib/planner/reminders"
import { localTimeZone } from "@/lib/planner/time"

type ChangesPage = { entries: Entry[]; lists: PlannerList[]; next_since: string | null; has_more: boolean; reset: boolean }
export type ImportSummary = {
  format: string
  events: number
  tasks: number
  errors: string[]
  dry_run: boolean
  created?: number
  updated?: number
  preview?: (Partial<Entry> & { title: string; kind: string; list_name: string | null })[]
}

export const plannerApi = {
  changes: (since: string | null) => call<ChangesPage>("GET", `/v1/planner/changes${since ? `?since=${since}` : ""}`),
  create: (body: Record<string, unknown>) => call<{ entry: Entry; created: boolean }>("POST", "/v1/planner/entries", body),
  update: (id: string, body: Record<string, unknown>) => call<{ entry: Entry; next_entry: Entry | null; merged: boolean }>("PATCH", `/v1/planner/entries/${id}`, body),
  remove: (id: string) => call<{ entry: Entry }>("DELETE", `/v1/planner/entries/${id}`),
  createList: (body: Record<string, unknown>) => call<{ list: PlannerList }>("POST", "/v1/planner/lists", body),
  updateList: (id: string, body: Record<string, unknown>) => call<{ list: PlannerList }>("PATCH", `/v1/planner/lists/${id}`, body),
  deleteList: (id: string) => call<void>("DELETE", `/v1/planner/lists/${id}`),
  import: (body: Record<string, unknown>) => call<ImportSummary>("POST", "/v1/planner/import", body),
  /** Downloads the export as a file (the request needs the sign-in header, so it is fetched, then saved). */
  download: async (format: "json" | "ics") => {
    const { data } = await browserSupabase().auth.getSession()
    if (!data.session) throw new ApiFailure(401, "unauthorized", "Sign in again")
    const res = await fetch(`/v1/planner/export?format=${format}`, { headers: { authorization: `Bearer ${data.session.access_token}` } })
    if (!res.ok) throw new ApiFailure(res.status, "export_failed", "Export failed")
    const blob = await res.blob()
    const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `dumpbox-planner.${format}`
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  },
}

const cacheKey = (uid: string) => `dumpbox.planner.v1.${uid}`
const FIRED_KEY = "dumpbox.planner.fired.v1"

type Cache = { since: string | null; entries: Entry[]; lists: PlannerList[] }

function loadCache(uid: string): Cache | null {
  try {
    const raw = localStorage.getItem(cacheKey(uid))
    return raw ? (JSON.parse(raw) as Cache) : null
  } catch {
    return null
  }
}
function saveCache(uid: string, c: Cache) {
  try {
    localStorage.setItem(cacheKey(uid), JSON.stringify(c))
  } catch {
    // storage full or blocked: memory still works
  }
}
export function clearPlannerCache() {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith("dumpbox.planner.")) localStorage.removeItem(k)
  } catch {
    // ignore
  }
}

export type Planner = ReturnType<typeof usePlanner>

export function usePlanner(userId: string | null, notify: (text: string, tone?: "ok" | "error", action?: { label: string; run: () => void }) => void) {
  const [entries, setEntries] = useState<Map<string, Entry>>(new Map())
  const [lists, setLists] = useState<PlannerList[]>([])
  const [prefs, setPrefsState] = useState<PlannerPrefs>(DEFAULT_PREFS)
  const [ready, setReady] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)
  const since = useRef<string | null>(null)
  const running = useRef<Promise<void> | null>(null)
  const again = useRef(false)
  // Every write below updates the ref first, then the state, so callbacks always see the latest copy.
  const entriesRef = useRef(entries)
  const listsRef = useRef(lists)
  const tz = useMemo(() => localTimeZone(), [])

  const persist = useCallback(() => {
    if (!userId) return
    saveCache(userId, { since: since.current, entries: [...entriesRef.current.values()], lists: listsRef.current })
  }, [userId])

  const apply = useCallback(
    (incoming: Entry[], newLists?: PlannerList[]) => {
      if (newLists) {
        listsRef.current = newLists
        setLists(newLists)
      }
      if (incoming.length) {
        const next = new Map(entriesRef.current)
        for (const e of incoming) {
          const have = next.get(e.id)
          if (have && have.version > e.version && have.version > 0) continue
          next.set(e.id, e)
        }
        entriesRef.current = next
        setEntries(next)
      }
      persist()
    },
    [persist],
  )

  const syncOnce = useCallback(async () => {
    for (let i = 0; i < 50; i++) {
      const r = await plannerApi.changes(since.current)
      if (r.reset) {
        since.current = null
        entriesRef.current = new Map()
        setEntries(new Map())
        continue
      }
      apply(r.entries, r.lists)
      since.current = r.next_since
      if (!r.has_more) break
    }
    persist()
  }, [apply, persist])

  const sync = useCallback(async () => {
    if (running.current) {
      again.current = true
      return running.current
    }
    const run = (async () => {
      try {
        do {
          again.current = false
          await syncOnce()
        } while (again.current)
        setSyncError(null)
      } catch (e) {
        if (!(e instanceof ApiFailure && e.offline)) setSyncError(e instanceof Error ? e.message : "Sync failed")
      } finally {
        setReady(true)
        running.current = null
      }
    })()
    running.current = run
    return run
  }, [syncOnce])

  // Start: cached copy first, then sync; prefs from the profile.
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    void (async () => {
      // Read the cached copy off the render path, then sync.
      await Promise.resolve()
      if (cancelled) return
      const c = loadCache(userId)
      if (c) {
        since.current = c.since
        const m = new Map(c.entries.map((e) => [e.id, e]))
        entriesRef.current = m
        setEntries(m)
        listsRef.current = c.lists
        setLists(c.lists)
        setReady(true)
      }
      await sync()
    })()
    call<{ user: { planner?: PlannerPrefs } }>("GET", "/v1/me")
      .then((r) => !cancelled && r.user.planner && setPrefsState({ ...DEFAULT_PREFS, ...r.user.planner }))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [userId, sync])

  // Keep in step: realtime nudges when the direct connection works, else every 15 s while visible, and on focus.
  useEffect(() => {
    if (!userId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    const nudge = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => sync(), 300)
    }
    const live$ = liveSupabase()
    let channel: ReturnType<typeof live$.channel> | null = null
    let live = false
    browserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (!data.session) return
        live$.realtime.setAuth(data.session.access_token)
        channel = live$
          .channel(`planner:${userId}`)
          .on("postgres_changes", { event: "*", schema: "public", table: "planner_entries", filter: `user_id=eq.${userId}` }, nudge)
          .on("postgres_changes", { event: "*", schema: "public", table: "planner_lists", filter: `user_id=eq.${userId}` }, nudge)
          .subscribe((s) => {
            live = s === "SUBSCRIBED"
          })
      })
    let ticks = 0
    const iv = setInterval(() => {
      ticks++
      if (document.visibilityState !== "visible") return
      if (!live || ticks % 4 === 0) nudge()
    }, 15_000)
    const onFocus = () => nudge()
    window.addEventListener("focus", onFocus)
    window.addEventListener("online", onFocus)
    return () => {
      clearInterval(iv)
      if (timer) clearTimeout(timer)
      window.removeEventListener("focus", onFocus)
      window.removeEventListener("online", onFocus)
      if (channel) live$.removeChannel(channel)
    }
  }, [userId, sync])

  // ---------------------------------------------------------------- reminders in this browser
  useEffect(() => {
    if (!userId) return
    const timers: ReturnType<typeof setTimeout>[] = []
    const now = new Date()
    const horizon = new Date(now.getTime() + 36 * 3600_000)
    // Catch reminders missed by up to 2 minutes (tab asleep, page just opened).
    const due = remindersBetween(entries.values(), new Date(now.getTime() - 120_000), horizon, tz, prefs.all_day_reminder_time)
    const fired = (() => {
      try {
        return new Set<string>(JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]") as string[])
      } catch {
        return new Set<string>()
      }
    })()
    for (const r of due) {
      if (fired.has(r.id)) continue
      const delay = Math.max(0, r.at.getTime() - Date.now())
      timers.push(
        setTimeout(() => {
          try {
            const f = new Set<string>(JSON.parse(localStorage.getItem(FIRED_KEY) ?? "[]") as string[])
            if (f.has(r.id)) return
            f.add(r.id)
            localStorage.setItem(FIRED_KEY, JSON.stringify([...f].slice(-500)))
          } catch {
            // ignore
          }
          const body = reminderBody(r, tz)
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              const n = new Notification(r.entry.title, { body, tag: r.id, icon: "/icon.svg" })
              n.onclick = () => window.focus()
            } catch {
              notify(`${r.entry.title} — ${body}`)
            }
          } else notify(`⏰ ${r.entry.title} — ${body}`)
        }, delay),
      )
    }
    return () => timers.forEach(clearTimeout)
  }, [entries, userId, tz, prefs.all_day_reminder_time, notify])

  // ---------------------------------------------------------------- changes
  const failText = (e: unknown) => (e instanceof ApiFailure ? (e.offline ? "You are offline. Try again when connected." : e.message) : "Something went wrong")

  const create = useCallback(
    async (body: Record<string, unknown>): Promise<Entry | null> => {
      const id = (body.id as string) ?? crypto.randomUUID()
      const now = new Date().toISOString()
      const draft: Entry = {
        id,
        kind: body.kind as Entry["kind"],
        list_id: (body.list_id as string) ?? null,
        parent_id: (body.parent_id as string) ?? null,
        title: String(body.title ?? ""),
        notes: (body.notes as string) ?? null,
        location: (body.location as string) ?? null,
        all_day: Boolean(body.all_day),
        start_at: (body.start_at as string) ?? null,
        end_at: (body.end_at as string) ?? null,
        start_date: (body.start_date as string) ?? null,
        end_date: (body.end_date as string) ?? null,
        time_zone: (body.time_zone as string) ?? tz,
        rrule: (body.rrule as string) ?? null,
        exdates: (body.exdates as string[]) ?? [],
        reminders: (body.reminders as number[]) ?? [],
        color: (body.color as string) ?? null,
        completed_at: body.completed ? now : null,
        starred: Boolean(body.starred),
        position: (body.position as number) ?? Date.now() / 1000,
        source_item_id: (body.source_item_id as string) ?? null,
        external_id: null,
        deleted_at: null,
        version: 0,
        created_at: now,
        updated_at: now,
      }
      apply([draft])
      try {
        const r = await plannerApi.create({ ...body, id, time_zone: body.time_zone ?? tz })
        const m = new Map(entriesRef.current)
        m.set(r.entry.id, r.entry)
        entriesRef.current = m
        setEntries(m)
        persist()
        return r.entry
      } catch (e) {
        const m = new Map(entriesRef.current)
        m.delete(id)
        entriesRef.current = m
        setEntries(m)
        notify(failText(e), "error")
        return null
      }
    },
    [apply, notify, persist, tz],
  )

  const update = useCallback(
    async (entry: Entry, patch: Record<string, unknown>, okText?: string): Promise<Entry | null> => {
      const before = entriesRef.current.get(entry.id) ?? entry
      const optimistic: Entry = { ...before, ...(patch as Partial<Entry>) }
      if ("completed" in patch) optimistic.completed_at = patch.completed ? new Date().toISOString() : null
      if ("deleted" in patch) optimistic.deleted_at = patch.deleted ? new Date().toISOString() : null
      const m0 = new Map(entriesRef.current)
      m0.set(entry.id, optimistic)
      entriesRef.current = m0
      setEntries(m0)
      try {
        const r = await plannerApi.update(entry.id, { ...patch, base_version: before.version > 0 ? before.version : undefined })
        const m = new Map(entriesRef.current)
        m.set(r.entry.id, r.entry)
        if (r.next_entry) m.set(r.next_entry.id, r.next_entry)
        entriesRef.current = m
        setEntries(m)
        persist()
        if (okText) notify(okText)
        // Subtasks moved with a binned/restored parent: pick them up.
        if ("deleted" in patch) sync()
        return r.entry
      } catch (e) {
        const m = new Map(entriesRef.current)
        m.set(entry.id, before)
        entriesRef.current = m
        setEntries(m)
        notify(failText(e), "error")
        return null
      }
    },
    [notify, persist, sync],
  )

  const remove = useCallback(
    async (entry: Entry) => {
      const r = await update(entry, { deleted: true })
      if (r) notify(`${entry.kind === "event" ? "Event" : "Task"} deleted`, undefined, { label: "Undo", run: () => void update(r, { deleted: false }) })
    },
    [notify, update],
  )

  const setPrefs = useCallback(
    async (p: Partial<PlannerPrefs>) => {
      setPrefsState((cur) => ({ ...cur, ...p }))
      try {
        const r = await call<{ user: { planner: PlannerPrefs } }>("PATCH", "/v1/me", { planner: p })
        setPrefsState({ ...DEFAULT_PREFS, ...r.user.planner })
      } catch (e) {
        notify(failText(e), "error")
      }
    },
    [notify],
  )

  const listOps = useMemo(
    () => ({
      create: async (kind: "calendar" | "tasks", name: string, color?: string) => {
        try {
          const r = await plannerApi.createList({ kind, name, color })
          apply([], [...listsRef.current, r.list])
          return r.list
        } catch (e) {
          notify(e instanceof ApiFailure && e.code === "conflict" ? "That name is already used" : failText(e), "error")
          return null
        }
      },
      update: async (l: PlannerList, patch: Partial<PlannerList>) => {
        apply([], listsRef.current.map((x) => (x.id === l.id ? { ...x, ...patch } : x)))
        try {
          const r = await plannerApi.updateList(l.id, patch)
          apply([], listsRef.current.map((x) => (x.id === l.id ? r.list : x)))
        } catch (e) {
          apply([], listsRef.current.map((x) => (x.id === l.id ? l : x)))
          notify(failText(e), "error")
        }
      },
      remove: async (l: PlannerList) => {
        try {
          await plannerApi.deleteList(l.id)
          apply([], listsRef.current.filter((x) => x.id !== l.id))
          await sync()
          return true
        } catch (e) {
          notify(failText(e), "error")
          return false
        }
      },
    }),
    [apply, notify, sync],
  )

  const live = useMemo(() => [...entries.values()].filter((e) => !e.deleted_at), [entries])
  const listById = useMemo(() => new Map(lists.map((l) => [l.id, l])), [lists])
  const colorOf = useCallback((e: Entry) => e.color ?? (e.list_id ? listById.get(e.list_id)?.color : undefined) ?? "#3a5bd9", [listById])

  return { entries: live, all: entries, lists, listById, colorOf, prefs, ready, syncError, tz, sync, create, update, remove, setPrefs, listOps }
}
