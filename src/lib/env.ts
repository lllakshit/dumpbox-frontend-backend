/**
 * Environment access. Public values are inlined by Next.js at build time; server values are read at request time
 * so a missing secret fails loudly in the request that needs it, not at import.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  supabasePublishableKey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "",
  appUrl: (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
}

export function requireServerEnv(name: "SUPABASE_SECRET_KEY" | "CRON_SECRET"): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing server environment variable ${name}`)
  return value
}

export function assertPublicEnv() {
  if (!publicEnv.supabaseUrl || !publicEnv.supabasePublishableKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")
  }
}
