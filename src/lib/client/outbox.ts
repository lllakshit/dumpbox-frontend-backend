"use client"
/**
 * Offline queue for captures made without a connection (text, links, places). Each entry keeps its client id, so
 * sending it twice never creates two items: the API returns the existing one. Files need a connection on the web.
 */
const KEY = "dumpbox.outbox.v1"

export type Pending = { id: string; payload: Record<string, unknown>; queuedAt: string; attempts: number; error?: string }

function read(): Pending[] {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Pending[]) : []
  } catch {
    return []
  }
}

function write(list: Pending[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // Storage full or blocked: the in-memory copy still shows the item as pending for this session.
  }
}

export const outbox = {
  all: read,
  add(p: Pending) {
    write([...read().filter((x) => x.id !== p.id), p])
  },
  remove(id: string) {
    write(read().filter((x) => x.id !== id))
  },
  update(id: string, patch: Partial<Pending>) {
    write(read().map((x) => (x.id === id ? { ...x, ...patch } : x)))
  },
}

/** Recent items kept for offline viewing and search. */
const CACHE_KEY = "dumpbox.feedcache.v1"
export const feedCache = {
  load<T>(): T[] {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]") as T[]
    } catch {
      return []
    }
  },
  save<T>(items: T[]) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(items.slice(0, 300)))
    } catch {
      // ignore
    }
  },
  clear() {
    try {
      localStorage.removeItem(CACHE_KEY)
      localStorage.removeItem(KEY)
    } catch {
      // ignore
    }
  },
}
