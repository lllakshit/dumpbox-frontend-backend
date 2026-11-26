import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok } from "@/lib/api/http"

type Row = { kind: string; name: string; total: number; fresh: number }

/** GET /v1/email/counts — for the Email sidebar: every label, priority and view with how many (and how many new). */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const { data, error } = await db.rpc("email_counts")
  if (error) throw fromDb(error)
  const rows = ((data ?? []) as Row[]).map((r) => ({ ...r, total: Number(r.total), fresh: Number(r.fresh) }))
  const one = (kind: string) => rows.find((r) => r.kind === kind) ?? { total: 0, fresh: 0 }
  return ok({
    all: one("all"),
    starred: one("starred").total,
    pinned: one("pinned").total,
    unread: one("unread").total,
    archived: one("archived").total,
    priorities: [1, 2, 3].map((p) => ({ priority: p, ...(rows.find((r) => r.kind === "priority" && r.name === String(p)) ?? { total: 0, fresh: 0 }) })),
    labels: rows
      .filter((r) => r.kind === "label")
      .map((r) => ({ name: r.name, total: r.total, fresh: r.fresh }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  })
})
