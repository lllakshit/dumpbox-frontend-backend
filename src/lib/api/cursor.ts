import { ApiError } from "./http"

/** Opaque, URL-safe cursor tokens. The contents are not secret, only not meant to be built by clients. */
export function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

export function decodeCursor<T extends Record<string, unknown>>(token: string | undefined, check: (v: unknown) => v is T): T | null {
  if (!token) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(token, "base64url").toString("utf8"))
    if (check(parsed)) return parsed
  } catch {
    // fall through
  }
  throw new ApiError("validation_failed", "Invalid cursor")
}

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type FeedCursor = { c: string; i: string }
export const isFeedCursor = (v: unknown): v is FeedCursor =>
  typeof v === "object" && v !== null && ISO.test(String((v as FeedCursor).c)) && UUID.test(String((v as FeedCursor).i))

/**
 * Sync position. `u`/`i` = last item (updated_at, id) seen; `t` = last tombstone time seen; `tail` = the client was
 * fully caught up when this token was issued, so the next read re-checks a short window for late commits;
 * `s` = when the token was issued (a device that has not synced for months must start over).
 */
export type ChangesCursor = { u: string; i: string; t: string; tail: boolean; s?: string }
export const isChangesCursor = (v: unknown): v is ChangesCursor =>
  typeof v === "object" &&
  v !== null &&
  ISO.test(String((v as ChangesCursor).u)) &&
  UUID.test(String((v as ChangesCursor).i)) &&
  ISO.test(String((v as ChangesCursor).t)) &&
  typeof (v as ChangesCursor).tail === "boolean" &&
  ((v as ChangesCursor).s === undefined || ISO.test(String((v as ChangesCursor).s)))

/** Characters that would change the meaning of a PostgREST `or=(...)` filter are rejected by the checks above. */
export function keysetBefore(cursor: FeedCursor) {
  return `created_at.lt.${cursor.c},and(created_at.eq.${cursor.c},id.lt.${cursor.i})`
}
export function keysetAfter(cursor: { u: string; i: string }) {
  return `updated_at.gt.${cursor.u},and(updated_at.eq.${cursor.u},id.gt.${cursor.i})`
}
