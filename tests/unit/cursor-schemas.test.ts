import { describe, expect, it } from "vitest"
import { decodeCursor, encodeCursor, isChangesCursor, isFeedCursor, keysetBefore } from "@/lib/api/cursor"
import { ApiError } from "@/lib/api/http"
import { createItemSchema, listItemsSchema, searchSchema, updateItemSchema } from "@/lib/api/schemas"

describe("cursors", () => {
  it("round-trips a feed cursor", () => {
    const c = { c: "2026-11-21T10:00:00.123456+00:00", i: "aaaaaaaa-0000-0000-0000-000000000001" }
    expect(decodeCursor(encodeCursor(c), isFeedCursor)).toEqual(c)
  })
  it("rejects tampered cursors that could inject filters", () => {
    const bad = encodeCursor({ c: "2026-01-01T00:00:00Z),or(user_id.neq.x", i: "aaaaaaaa-0000-0000-0000-000000000001" })
    expect(() => decodeCursor(bad, isFeedCursor)).toThrow(ApiError)
    expect(() => decodeCursor("not-base64!!", isFeedCursor)).toThrow(ApiError)
  })
  it("accepts changes cursors with and without issue time", () => {
    const base = { u: "2026-11-21T10:00:00Z", i: "aaaaaaaa-0000-0000-0000-000000000001", t: "1970-01-01T00:00:00Z", tail: true }
    expect(isChangesCursor(base)).toBe(true)
    expect(isChangesCursor({ ...base, s: "2026-11-21T10:00:01.000Z" })).toBe(true)
    expect(isChangesCursor({ ...base, tail: "yes" })).toBe(false)
  })
  it("builds a keyset filter", () => {
    expect(keysetBefore({ c: "2026-11-21T10:00:00Z", i: "x" })).toBe("created_at.lt.2026-11-21T10:00:00Z,and(created_at.eq.2026-11-21T10:00:00Z,id.lt.x)")
  })
})

describe("schemas", () => {
  it("requires text for notes, url for links, coordinates for places", () => {
    expect(createItemSchema.safeParse({ type: "note", body: "  " }).success).toBe(false)
    expect(createItemSchema.safeParse({ type: "link" }).success).toBe(false)
    expect(createItemSchema.safeParse({ type: "link", url: "javascript:alert(1)" }).success).toBe(false)
    expect(createItemSchema.safeParse({ type: "location", latitude: 1 }).success).toBe(false)
    expect(createItemSchema.parse({ type: "note", body: "hi" }).source).toBe("web")
  })
  it("rejects empty updates", () => {
    expect(updateItemSchema.safeParse({ base_version: 2 }).success).toBe(false)
    expect(updateItemSchema.safeParse({ starred: true }).success).toBe(true)
  })
  it("parses list and search query strings", () => {
    expect(listItemsSchema.parse({ type: "note,link", limit: "10" })).toMatchObject({ view: "feed", type: ["note", "link"], limit: 10 })
    expect(listItemsSchema.safeParse({ type: "note,evil" }).success).toBe(false)
    expect(searchSchema.parse({ q: "bill", starred: "true" })).toMatchObject({ q: "bill", starred: true, include_archived: true })
  })
})
