import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { handler, ok, readJson } from "@/lib/api/http"
import { resolveParsed } from "@/lib/planner/resolve"
import { parseQuickAdd } from "@/lib/planner/parse"
import { isTimeZone, toWall } from "@/lib/planner/time"

const schema = z.object({
  text: z.string().trim().min(1).max(2000),
  time_zone: z.string().max(64).refine(isTimeZone, "Unknown time zone").default("UTC"),
  /** Defaults to the server clock. */
  now: z.iso.datetime({ offset: true }).optional(),
  /** What to make when the text does not say (the screen the user is on). */
  kind: z.enum(["event", "task"]).default("event"),
  week_start: z.union([z.literal(0), z.literal(1), z.literal(6)]).default(1),
  default_event_minutes: z.number().int().min(5).max(1440).default(60),
})

/**
 * POST /v1/planner/parse — quick add. `{ text: "Dentist tomorrow 5pm remind me 1h before", time_zone }` returns
 * what was understood and a ready `entry` body for POST /v1/planner/entries (list chosen by the caller).
 */
export const POST = handler(async (request: Request) => {
  await requireUser(request)
  const input = schema.parse(await readJson(request, 16 * 1024))
  const now = input.now ? new Date(input.now) : new Date()
  const parsed = parseQuickAdd(input.text, toWall(now, input.time_zone), { weekStart: input.week_start })
  return ok({ parsed, entry: resolveParsed(parsed, { tz: input.time_zone, kind: input.kind, defaultEventMinutes: input.default_event_minutes }) })
})
