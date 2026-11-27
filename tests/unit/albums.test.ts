import { describe, expect, it } from "vitest"
import { groupIntoAlbums } from "@/lib/client/albums"
import type { Item } from "@/lib/client/types"

const t0 = Date.parse("2026-11-27T06:00:00Z")
const at = (s: number) => new Date(t0 + s * 1000).toISOString()
const photo = (id: string, s: number, o: Partial<Item> = {}): Item => ({
  id, type: "image", title: null, body: null, source: "web", url: null, link: null, location: null, pinned: false, starred: false,
  archived_at: null, deleted_at: null, version: 1, created_at: at(s), updated_at: at(s), tags: [], collection_ids: [],
  files: [{ id: `f-${id}`, file_name: `${id}.png`, mime_type: "image/png", size_bytes: 1, sha256: null, width: null, height: null, created_at: at(s) }],
  ...o,
})
const note = (id: string, s: number) => photo(id, s, { type: "note", files: [], body: "hi" })
const ids = (rows: Item[][]) => rows.map((r) => r.map((i) => i.id).join("+"))
const group = (list: Item[]) => ids(groupIntoAlbums(list, (i) => i))

describe("groupIntoAlbums (newest first, same rules as the phone app)", () => {
  it("groups photos sent together; a note splits them", () => {
    expect(group([photo("p4", 40), photo("p3", 30), note("n", 20), photo("p2", 10), photo("p1", 0)])).toEqual(["p4+p3", "n", "p2+p1"])
  })
  it("leaves a single photo alone", () => expect(group([note("n", 10), photo("p1", 0)])).toEqual(["n", "p1"]))
  it("splits photos more than 2 minutes apart", () => expect(group([photo("b", 200), photo("a", 0)])).toEqual(["b", "a"]))
  it("splits different tags", () =>
    expect(group([photo("b", 5, { tags: [{ id: "x", name: "x", color: null }] }), photo("a", 0)])).toEqual(["b", "a"]))
  it("a captioned first photo closes the album", () =>
    expect(group([photo("p3", 20), photo("p2", 10), photo("p1", 5, { body: "trip" }), photo("p0", 0)])).toEqual(["p3+p2+p1", "p0"]))
  it("a newest captioned photo is not merged", () => expect(group([photo("p2", 10, { body: "x" }), photo("p1", 0)])).toEqual(["p2", "p1"]))
  it("keeps out items the caller excludes (still uploading)", () => {
    const rows = [photo("b", 10), photo("a", 0)]
    expect(ids(groupIntoAlbums(rows, (i) => i, (i) => i.id !== "b"))).toEqual(["b", "a"])
  })
})
