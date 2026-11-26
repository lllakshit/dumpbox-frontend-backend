import { describe, expect, it } from "vitest"
import { clean, clipBytes, clipChars, importSchema, likePattern, messageRows, parseAddress, snippetOf, threadRow } from "@/lib/email/normalize"

const USER = "11111111-1111-1111-1111-111111111111"

function thread(overrides: Record<string, unknown> = {}) {
  return importSchema.parse({
    threads: [
      {
        external_id: "18c0ffee",
        subject: "Invoice for November",
        labels: ["Bills", "Work/Clients/Acme", "bills"],
        starred: true,
        important: true,
        unread: true,
        priority: 1,
        message_count: 7,
        messages: [
          { external_id: "m2", from: "Me <me@x.com>", to: "Ravi <ravi@acme.com>", sent_at: "2026-11-20T11:00:00Z", body_text: "Thanks, paid.\n\nOn Mon, Ravi wrote:\n> please pay" },
          { external_id: "m1", from: "\"Ravi Kumar\" <Ravi@Acme.com>", to: "me@x.com", sent_at: "2026-11-19T09:00:00Z", body_text: "Please pay   the invoice.", attachments: [{ name: "inv.pdf", size: 2048, mime: "application/pdf" }] },
        ],
        ...overrides,
      },
    ],
  }).threads[0]
}

describe("email import", () => {
  it("parses Gmail address formats", () => {
    expect(parseAddress('"Ravi Kumar" <Ravi@Acme.com>')).toEqual({ name: "Ravi Kumar", email: "ravi@acme.com" })
    expect(parseAddress("me@x.com")).toEqual({ name: null, email: "me@x.com" })
    expect(parseAddress("")).toEqual({ name: null, email: null })
  })

  it("builds one thread row: labels deduplicated, latest sender and snippet, dates from messages", () => {
    const row = threadRow(USER, thread())
    expect(row.labels).toEqual(["Bills", "Work/Clients/Acme"])
    expect(row.from_email).toBe("me@x.com")
    expect(row.snippet).toBe("Thanks, paid.")
    expect(row.participants).toEqual(["Ravi Kumar", "Me"])
    expect(row.first_message_at).toBe("2026-11-19T09:00:00.000Z")
    expect(row.last_message_at).toBe("2026-11-20T11:00:00.000Z")
    expect(row.message_count).toBe(7)
    expect(row.has_attachments).toBe(true)
    expect(row.priority).toBe(1)
    // DumpBox-owned flags are never part of an import, so a re-import cannot reset them.
    expect(row).not.toHaveProperty("pinned")
    expect(row).not.toHaveProperty("archived_at")
    expect(row).not.toHaveProperty("deleted_at")
  })

  it("builds message rows with parsed senders", () => {
    const rows = messageRows(USER, "t1", thread())
    expect(rows.map((r) => r.external_id)).toEqual(["m2", "m1"])
    expect(rows[1]).toMatchObject({ from_name: "Ravi Kumar", from_email: "ravi@acme.com", thread_id: "t1" })
    expect(rows[1].attachments).toEqual([{ name: "inv.pdf", size: 2048, mime: "application/pdf" }])
  })

  it("rejects a thread with no messages and a bad priority", () => {
    expect(() => thread({ messages: [] })).toThrow()
    expect(() => thread({ priority: 4 })).toThrow()
  })

  it("cuts long bodies by bytes without breaking characters", () => {
    const s = "é".repeat(10)
    const cut = clipBytes(s, 5)
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(5)
    expect(cut).toBe("éé")
  })

  it("snippet drops quoted history and collapses spaces", () => {
    expect(snippetOf("Hi  there\n\n> old\nbye")).toBe("Hi there bye")
  })

  it("escapes wildcards in search", () => {
    expect(likePattern("50%_off")).toBe("%50\\%\\_off%")
  })

  it("makes text the database accepts: no NUL, no half emoji, long names cut", () => {
    expect(clean("a\u0000b")).toBe("ab")
    expect(clean("x\ud83dy")).toBe("x\uFFFDy")
    expect(clean("ok 😀")).toBe("ok 😀")
    expect(clipChars("ab😀", 3)).toBe("ab")
    const t = thread({ subject: "Hi\u0000 \ud83d", messages: [{ external_id: "m1", from: `"${"N".repeat(400)}" <${"e".repeat(400)}@x.com>`, sent_at: "2026-11-19T09:00:00Z", body_text: "body\u0000 \udc00" }] })
    expect(t.subject).toBe("Hi \uFFFD")
    const row = messageRows(USER, "t1", t)[0]
    expect(row.from_name!.length).toBe(300)
    expect(row.from_email!.length).toBe(320)
    expect(row.body_text).toBe("body \uFFFD")
  })
})
