import { requireUser } from "@/lib/api/auth"
import { fromDb, handler, ok, readJson } from "@/lib/api/http"
import { ensureLists, listSchema } from "@/lib/api/planner"
import { LIST_COLORS, LIST_COLUMNS } from "@/lib/planner/types"

/** GET /v1/planner/lists — calendars and task lists (the defaults are created on first use). */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  return ok({ lists: await ensureLists(db) })
})

/** POST /v1/planner/lists — { kind: "calendar" | "tasks", name, color? } */
export const POST = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const input = listSchema.parse(await readJson(request))
  const lists = await ensureLists(db)
  const color = input.color ?? LIST_COLORS[lists.filter((l) => l.kind === input.kind).length % LIST_COLORS.length]
  const position = Math.max(0, ...lists.filter((l) => l.kind === input.kind).map((l) => l.position)) + 1
  const { data, error } = await db.from("planner_lists").insert({ kind: input.kind, name: input.name, color, position }).select(LIST_COLUMNS).single()
  if (error) throw fromDb(error)
  return ok({ list: data }, 201)
})
