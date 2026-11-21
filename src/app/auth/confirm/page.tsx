"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import type { EmailOtpType } from "@supabase/supabase-js"
import { browserSupabase } from "@/lib/client/supabase"

const TYPES: EmailOtpType[] = ["email", "magiclink", "signup", "invite", "recovery", "email_change"]

/**
 * Sign-in link from the DumpBox email: /auth/confirm?token_hash=…&type=email. It is checked through this site's
 * /sb proxy (never supabase.co directly) and works in any browser, not only the one that asked for it.
 */
export default function ConfirmPage() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const tokenHash = p.get("token_hash")
    const type = (p.get("type") ?? "email") as EmailOtpType
    if (!tokenHash || !TYPES.includes(type)) {
      Promise.resolve().then(() => setError("This sign-in link is incomplete."))
      return
    }
    browserSupabase()
      .auth.verifyOtp({ token_hash: tokenHash, type })
      .then(({ error: err }) => {
        if (err) setError("This sign-in link has expired or was already used. Ask for a new one.")
        else router.replace("/")
      })
  }, [router])

  return (
    <main className="grid min-h-full place-items-center p-6 text-center">
      {error ? (
        <div>
          <p className="text-danger">{error}</p>
          <a href="/login" className="mt-3 inline-block text-accent underline">
            Back to sign in
          </a>
        </div>
      ) : (
        <p className="text-ink-2">Signing you in…</p>
      )}
    </main>
  )
}
