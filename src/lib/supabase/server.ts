import "server-only"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { assertPublicEnv, publicEnv, requireServerEnv } from "@/lib/env"

const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }

/** Client that acts as the signed-in user: every query goes through row-level security. */
export function userClient(accessToken: string): SupabaseClient {
  assertPublicEnv()
  return createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
    auth: noSession,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

/**
 * Server-only client with the secret key. It bypasses row-level security, so use it only where the code itself
 * checks access: public share pages, account deletion, the trash purge job.
 */
export function adminClient(): SupabaseClient {
  assertPublicEnv()
  return createClient(publicEnv.supabaseUrl, requireServerEnv("SUPABASE_SECRET_KEY"), { auth: noSession })
}

/** Client used only to verify access tokens. */
export function anonClient(): SupabaseClient {
  assertPublicEnv()
  return createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, { auth: noSession })
}
