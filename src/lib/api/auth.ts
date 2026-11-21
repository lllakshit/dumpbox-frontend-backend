import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ApiError } from "./http"
import { anonClient, userClient } from "@/lib/supabase/server"

export type AuthContext = { userId: string; email: string | null; token: string; db: SupabaseClient }

/**
 * Reads `Authorization: Bearer <access token>`, verifies it with Supabase Auth and returns a database client that
 * acts as that user. Every /v1 route (except public share pages) starts here.
 */
export async function requireUser(request: Request): Promise<AuthContext> {
  const header = request.headers.get("authorization") ?? ""
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  if (!match) throw new ApiError("unauthorized", "Sign in required")
  const token = match[1]
  const { data, error } = await anonClient().auth.getClaims(token)
  const sub = data?.claims?.sub
  if (error || !sub || data?.claims?.role !== "authenticated") throw new ApiError("unauthorized", "Session expired, sign in again")
  return { userId: sub, email: (data.claims.email as string | undefined) ?? null, token, db: userClient(token) }
}
