"use client"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { publicEnv } from "@/lib/env"

let client: SupabaseClient | null = null

/** One browser client per tab; the session lives in localStorage and refreshes itself. */
export function browserSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return client
}
