/**
 * Email import: the request shape the Gmail script sends, and how one conversation becomes a thread row plus
 * message rows. Pure (no database), so it is unit tested.
 */
import { z } from "zod"

export const MAX_THREADS_PER_IMPORT = 50
export const MAX_MESSAGES_PER_THREAD = 100
export const MAX_BODY_BYTES = 150_000
const SEARCH_BYTES = 50_000

const text = (max: number) =>
  z
    .string()
    .nullish()
    .transform((v) => clipChars(clean(v ?? ""), max))

const attachment = z.object({
  name: text(300),
  size: z.number().int().min(0).max(1e10).nullish(),
  mime: text(200),
})

export const importMessageSchema = z.object({
  external_id: z.string().trim().min(1).max(200),
  /** "Name <email>" as Gmail shows it. */
  from: text(2000),
  to: text(4000),
  cc: text(4000),
  sent_at: z.iso.datetime({ offset: true }),
  body_text: z
    .string()
    .nullish()
    .transform((v) => clipBytes(clean(v ?? ""), MAX_BODY_BYTES)),
  unread: z.boolean().default(false),
  attachments: z.array(attachment).max(50).default([]),
})

export const importThreadSchema = z.object({
  external_id: z.string().trim().min(1).max(200),
  subject: text(1000),
  labels: z
    .array(z.string().trim().min(1).max(200))
    .max(100)
    .default([])
    .transform((l) => uniqueCi(l.map((x) => clean(x)).filter(Boolean))),
  starred: z.boolean().default(false),
  important: z.boolean().default(false),
  unread: z.boolean().default(false),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).nullish(),
  /** False when the conversation no longer has any label the script syncs (it then shows under Archived). */
  in_scope: z.boolean().default(true),
  /** Total messages in Gmail (the script may send only the latest ones). */
  message_count: z.number().int().min(0).max(100_000).optional(),
  messages: z.array(importMessageSchema).min(1).max(MAX_MESSAGES_PER_THREAD),
})

export const importSchema = z.object({
  threads: z.array(importThreadSchema).min(1).max(MAX_THREADS_PER_IMPORT),
})

export type ImportThread = z.infer<typeof importThreadSchema>
export type ImportMessage = z.infer<typeof importMessageSchema>

/** "Ravi Kumar <ravi@x.com>" → { name: "Ravi Kumar", email: "ravi@x.com" }; a bare address keeps name null. */
export function parseAddress(raw: string): { name: string | null; email: string | null } {
  const s = raw.trim()
  if (!s) return { name: null, email: null }
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(s)
  if (m) {
    const email = clipChars(m[2].trim().toLowerCase(), 320)
    return { name: clipChars(m[1].trim(), 300) || null, email: email || null }
  }
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { name: null, email: clipChars(s.toLowerCase(), 320) }
  return { name: clipChars(s, 300), email: null }
}

/** Short name for lists: the display name, else the part of the address before @. */
export function shortName(a: { name: string | null; email: string | null }) {
  return a.name || (a.email ? a.email.split("@")[0] : "Unknown")
}

/**
 * Text Postgres accepts: no NUL characters, and no half emoji (a lone UTF-16 surrogate, which Gmail text or a cut
 * on the script side can leave) — either one would make the database refuse the whole import.
 */
export function clean(v: string) {
  return v.replace(/\u0000/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

/** At most `max` UTF-16 units without cutting an emoji in half. */
export function clipChars(v: string, max: number) {
  if (v.length <= max) return v
  const cut = v.slice(0, max)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** Cut to at most `max` UTF-8 bytes without splitting a character. */
export function clipBytes(v: string, max: number) {
  const bytes = new TextEncoder().encode(v)
  if (bytes.length <= max) return v
  let out = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, max))
  if (out.endsWith("�")) out = out.slice(0, -1)
  return out
}

function uniqueCi(list: string[]) {
  const seen = new Set<string>()
  return list.filter((x) => {
    const k = x.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

/** First ~200 characters of a body, whitespace collapsed, quoted reply history ("On … wrote:") left out. */
export function snippetOf(body: string) {
  const cut = body.split(/\n\s*On .{5,200}wrote:\s*\n/)[0] ?? body
  return clipChars(cut.replace(/^>.*$/gm, "").replace(/\s+/g, " ").trim(), 200)
}

/** Gmail-owned columns of the thread row (DumpBox-owned columns are never sent, so an import cannot reset them). */
export function threadRow(userId: string, t: ImportThread) {
  const msgs = [...t.messages].sort((a, b) => a.sent_at.localeCompare(b.sent_at))
  const last = msgs[msgs.length - 1]
  const lastFrom = parseAddress(last.from)
  const people: string[] = []
  for (const m of msgs) {
    const n = shortName(parseAddress(m.from))
    if (!people.includes(n)) people.push(n)
  }
  const search = [
    t.subject,
    t.labels.join(" "),
    ...msgs.map((m) => `${m.from} ${m.to} ${m.cc}`),
    ...msgs.map((m) => m.body_text).reverse(),
  ].join("\n")
  return {
    user_id: userId,
    provider: "gmail" as const,
    external_id: t.external_id,
    subject: t.subject,
    snippet: snippetOf(last.body_text),
    from_name: lastFrom.name,
    from_email: lastFrom.email,
    participants: people.slice(0, 50),
    labels: t.labels,
    message_count: Math.max(t.message_count ?? 0, msgs.length),
    has_attachments: msgs.some((m) => m.attachments.length > 0),
    starred: t.starred,
    important: t.important,
    unread: t.unread,
    priority: t.priority ?? null,
    in_scope: t.in_scope,
    first_message_at: new Date(msgs[0].sent_at).toISOString(),
    last_message_at: new Date(last.sent_at).toISOString(),
    search_text: clipBytes(search, SEARCH_BYTES),
  }
}

export function messageRows(userId: string, threadId: string, t: ImportThread) {
  return t.messages.map((m) => {
    const from = parseAddress(m.from)
    return {
      user_id: userId,
      thread_id: threadId,
      external_id: m.external_id,
      from_name: from.name,
      from_email: from.email,
      to_list: m.to || null,
      cc_list: m.cc || null,
      sent_at: new Date(m.sent_at).toISOString(),
      body_text: m.body_text,
      attachments: m.attachments.map((a) => ({ name: a.name, size: a.size ?? null, mime: a.mime || null })),
      unread: m.unread,
    }
  })
}

/** For a `like` filter: escape the wildcard characters a person might type. */
export function likePattern(q: string) {
  // PostgREST reads "*" as a wildcard too, so it is searched as a space.
  return `%${q.replace(/\*/g, " ").replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
