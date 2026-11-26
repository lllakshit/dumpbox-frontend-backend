"use client"
import { call } from "./api"

export type EmailThread = {
  id: string
  provider: "gmail"
  external_id: string
  subject: string
  snippet: string
  from_name: string | null
  from_email: string | null
  participants: string[]
  labels: string[]
  message_count: number
  has_attachments: boolean
  starred: boolean
  important: boolean
  unread: boolean
  priority: 1 | 2 | 3 | null
  /** False when it no longer has a label the Gmail script syncs. */
  in_scope: boolean
  /** Not archived and still in scope. */
  in_inbox: boolean
  first_message_at: string | null
  last_message_at: string
  pinned: boolean
  archived_at: string | null
  opened_at: string | null
  seen_message_at: string | null
  fresh: boolean
}

export type EmailMessage = {
  id: string
  external_id: string
  from_name: string | null
  from_email: string | null
  to_list: string | null
  cc_list: string | null
  sent_at: string
  body_text: string
  attachments: { name: string; size: number | null; mime: string | null }[]
  unread: boolean
}

export type Count = { total: number; fresh: number }
export type EmailCounts = {
  all: Count
  starred: number
  pinned: number
  unread: number
  archived: number
  priorities: ({ priority: 1 | 2 | 3 } & Count)[]
  labels: ({ name: string } & Count)[]
}

export type EmailView = "inbox" | "new" | "unread" | "starred" | "pinned" | "archived"
export type EmailFilter = { view: EmailView; label?: string; priority?: 1 | 2 | 3 }
export type ImportKey = { id: string; label: string; created_at: string; last_used_at: string | null }

export const PRIORITY_LABEL: Record<1 | 2 | 3, string> = { 1: "High", 2: "Medium", 3: "Low" }

export const emailApi = {
  threads: (f: EmailFilter, q: string, cursor?: string | null) => {
    const p = new URLSearchParams({ view: f.view, limit: "50" })
    if (f.label) p.set("label", f.label)
    if (f.priority) p.set("priority", String(f.priority))
    if (q.trim()) p.set("q", q.trim())
    if (cursor) p.set("cursor", cursor)
    return call<{ threads: EmailThread[]; next_cursor: string | null }>("GET", `/v1/email/threads?${p}`)
  },
  thread: (id: string) => call<{ thread: EmailThread; messages: EmailMessage[] }>("GET", `/v1/email/threads/${id}`),
  update: (id: string, body: { pinned?: boolean; archived?: boolean }) => call<{ thread: EmailThread }>("PATCH", `/v1/email/threads/${id}`, body),
  remove: (id: string) => call<void>("DELETE", `/v1/email/threads/${id}`),
  counts: () => call<EmailCounts>("GET", "/v1/email/counts"),
  keys: () => call<{ keys: ImportKey[] }>("GET", "/v1/email/import-keys"),
  createKey: (label: string) => call<ImportKey & { key: string; api_url: string }>("POST", "/v1/email/import-keys", { label }),
  deleteKey: (id: string) => call<void>("DELETE", `/v1/email/import-keys?id=${id}`),
}

export function gmailUrl(t: Pick<EmailThread, "external_id">) {
  return `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(t.external_id)}`
}

/** List date: time today, "12 Nov" this year, "12 Nov 2025" before. */
export function shortDate(iso: string) {
  const d = new Date(iso)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" })
}

export function fullDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" })
}

/** "Ravi, Me, Asha (4)" like Gmail's list. */
export function senders(t: EmailThread) {
  const names = t.participants.length ? t.participants : [t.from_name || t.from_email || "Unknown"]
  const shown = names.length > 3 ? [names[0], "…", ...names.slice(-2)] : names
  return `${shown.join(", ")}${t.message_count > 1 ? ` (${t.message_count})` : ""}`
}
