import { connection } from "next/server"

/** GET /v1/health — liveness for uptime checks. */
export async function GET() {
  await connection()
  return Response.json({ status: "ok", time: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } })
}
