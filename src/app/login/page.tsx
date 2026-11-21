"use client"
import { useEffect, useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { browserSupabase } from "@/lib/client/supabase"

/** Sign in with a 6-digit email code, or with Google. */
export default function LoginPage() {
  const router = useRouter()
  const [step, setStep] = useState<"email" | "code">("email")
  const [email, setEmail] = useState("")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  useEffect(() => {
    browserSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session) router.replace("/")
      })
  }, [router])

  async function sendCode(e?: FormEvent) {
    e?.preventDefault()
    setError(null)
    setBusy(true)
    const { error: err } = await browserSupabase().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: true } })
    setBusy(false)
    if (err) {
      setError(err.status === 429 ? "Too many requests. Wait a minute and try again." : err.message)
      return
    }
    setStep("code")
    setInfo(`We sent a 6-digit code to ${email.trim()}. It expires in 10 minutes.`)
  }

  async function verify(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    const { error: err } = await browserSupabase().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: "email" })
    setBusy(false)
    if (err) {
      setError("That code is not right or has expired. Check it, or send a new one.")
      return
    }
    router.replace("/")
  }

  async function google() {
    setError(null)
    const { error: err } = await browserSupabase().auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/auth/callback` },
    })
    if (err) setError(err.message.includes("not enabled") ? "Google sign-in is not set up yet. Use the email code." : err.message)
  }

  return (
    <main className="min-h-full flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl bg-accent text-accent-ink text-xl font-bold shadow-[var(--shadow)]" aria-hidden="true">
            D
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">DumpBox</h1>
          <p className="mt-1 text-sm text-ink-2">Dump anything in one tap. Find it in one search.</p>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-[var(--shadow)]">
          {step === "email" ? (
            <form onSubmit={sendCode} className="space-y-3">
              <label htmlFor="email" className="block text-sm font-medium">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-base outline-none focus:border-accent"
                placeholder="you@example.com"
              />
              <button disabled={busy} className="w-full rounded-xl bg-accent px-4 py-2.5 font-medium text-accent-ink disabled:opacity-60">
                {busy ? "Sending…" : "Send sign-in code"}
              </button>
            </form>
          ) : (
            <form onSubmit={verify} className="space-y-3">
              {info ? <p className="text-sm text-ink-2">{info}</p> : null}
              <label htmlFor="code" className="block text-sm font-medium">
                6-digit code
              </label>
              <input
                id="code"
                required
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="w-full rounded-xl border border-line bg-bg px-3 py-2.5 text-center text-xl tracking-[0.4em] outline-none focus:border-accent"
                autoFocus
              />
              <button disabled={busy || code.length !== 6} className="w-full rounded-xl bg-accent px-4 py-2.5 font-medium text-accent-ink disabled:opacity-60">
                {busy ? "Checking…" : "Sign in"}
              </button>
              <div className="flex justify-between text-sm">
                <button type="button" className="text-ink-2 underline" onClick={() => setStep("email")}>
                  Change email
                </button>
                <button type="button" className="text-accent underline" disabled={busy} onClick={() => sendCode()}>
                  Send a new code
                </button>
              </div>
            </form>
          )}

          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          ) : null}

          <div className="my-4 flex items-center gap-3 text-xs text-ink-3">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <button onClick={google} className="w-full rounded-xl border border-line bg-bg px-4 py-2.5 font-medium">
            Continue with Google
          </button>
        </div>
        <p className="mt-6 text-center text-xs text-ink-3">Your items are private to your account.</p>
      </div>
    </main>
  )
}
