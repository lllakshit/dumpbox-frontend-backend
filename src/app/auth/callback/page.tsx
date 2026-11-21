"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { browserSupabase } from "@/lib/client/supabase"

/** Google sign-in returns here with ?code=…; the Supabase client exchanges it (PKCE) and we go to the feed. */
export default function AuthCallback() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const errDesc = params.get("error_description")
    if (errDesc) {
      // Deferred so the first render finishes before showing the provider's error.
      Promise.resolve().then(() => setError(errDesc))
      return
    }
    const sb = browserSupabase()
    const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
      if (session) router.replace("/")
    })
    sb.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/")
    })
    const t = setTimeout(() => setError("Sign-in did not complete. Try again."), 10_000)
    return () => {
      sub.subscription.unsubscribe()
      clearTimeout(t)
    }
  }, [router])

  return (
    <main className="min-h-full grid place-items-center p-6 text-center">
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
