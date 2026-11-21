"use client"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { publicEnv } from "@/lib/env"

let client: SupabaseClient | null = null
let live: SupabaseClient | null = null

/**
 * One browser client per tab, reaching Supabase through this site's /sb proxy (some networks block *.supabase.co).
 * The session lives in localStorage and refreshes itself.
 */
export function browserSupabase(): SupabaseClient {
  if (!client) {
    const url = typeof window === "undefined" ? publicEnv.supabaseUrl : `${window.location.origin}/sb`
    client = createClient(url, publicEnv.supabasePublishableKey, {
      auth: { flowType: "pkce", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: "dumpbox-auth" },
    })
  }
  return client
}

/**
 * Realtime needs a WebSocket, which the proxy cannot carry, so it connects to Supabase directly. Where that is
 * blocked it simply never connects and the app falls back to checking for changes every few seconds.
 */
export function liveSupabase(): SupabaseClient {
  if (!live) {
    live = createClient(publicEnv.supabaseUrl, publicEnv.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { reconnectAfterMs: (tries: number) => Math.min(60_000, 2_000 * 2 ** tries) },
    })
  }
  return live
}
