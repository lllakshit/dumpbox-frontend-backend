"use client"
import { useEffect, useState } from "react"
import { api, ApiFailure } from "@/lib/client/api"
import type { Share } from "@/lib/client/types"
import { Button, formatBytes } from "./ui"

type Me = Awaited<ReturnType<typeof api.me>>
type Theme = "system" | "light" | "dark"

function readTheme(): Theme {
  try {
    const t = localStorage.getItem("dumpbox.theme")
    return t === "light" || t === "dark" ? t : "system"
  } catch {
    return "system"
  }
}

/** Saves the choice and applies it to the page (outside React: the root element is not component state). */
function persistTheme(t: Theme) {
  const root = document.documentElement
  try {
    if (t === "system") localStorage.removeItem("dumpbox.theme")
    else localStorage.setItem("dumpbox.theme", t)
  } catch {
    // private mode: still apply for this visit
  }
  if (t === "system") delete root.dataset.theme
  else root.dataset.theme = t
}

/** Profile, usage, theme, shared links, export, sign out, delete account. */
export function SettingsPanel({ onSignOut, onDeleteAccount, notify }: { onSignOut: () => void; onDeleteAccount: () => void; notify: (text: string, tone?: "ok" | "error") => void }) {
  const [me, setMe] = useState<Me | null>(null)
  const [name, setName] = useState("")
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [shares, setShares] = useState<Share[] | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    api
      .me()
      .then((r) => {
        setMe(r)
        setName(r.user.name ?? "")
      })
      .catch(() => {})
    api
      .shares()
      .then((r) => setShares(r.shares))
      .catch(() => setShares([]))
  }, [])

  function applyTheme(t: Theme) {
    setTheme(t)
    persistTheme(t)
  }

  async function exportAll() {
    setExporting(true)
    try {
      const data = await api.exportAll()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = `dumpbox-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    } catch (e) {
      notify(e instanceof ApiFailure ? e.message : "Export failed", "error")
    } finally {
      setExporting(false)
    }
  }

  const label = (s: Share) => s.collections?.name ?? s.items?.title ?? s.items?.link_title ?? s.items?.body?.slice(0, 60) ?? s.items?.url ?? (s.collection_id ? "Collection" : "Item")

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-5 md:px-6">
      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Profile</h2>
        <p className="mb-3 text-sm text-ink-2">{me?.user.email ?? "…"}</p>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await api.updateMe({ name: name.trim() })
              notify("Saved")
            } catch {
              notify("Could not save", "error")
            }
          }}
        >
          <label htmlFor="name" className="sr-only">
            Name
          </label>
          <input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={100} className="flex-1 rounded-xl border border-line bg-bg px-3 py-2 outline-none focus:border-accent" />
          <Button type="submit">Save</Button>
        </form>
        {me ? (
          <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-panel-2 p-2">
              <dt className="text-xs text-ink-3">Items</dt>
              <dd className="font-semibold">{me.usage.items}</dd>
            </div>
            <div className="rounded-xl bg-panel-2 p-2">
              <dt className="text-xs text-ink-3">Files</dt>
              <dd className="font-semibold">{me.usage.files}</dd>
            </div>
            <div className="rounded-xl bg-panel-2 p-2">
              <dt className="text-xs text-ink-3">Storage</dt>
              <dd className="font-semibold">{formatBytes(me.usage.storage_bytes)}</dd>
            </div>
          </dl>
        ) : null}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="mb-3 font-semibold">Appearance</h2>
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {(["system", "light", "dark"] as Theme[]).map((t) => (
            <button key={t} role="radio" aria-checked={theme === t} onClick={() => applyTheme(t)} className={`flex-1 rounded-xl border px-3 py-2 text-sm capitalize ${theme === t ? "border-accent bg-accent-soft text-accent" : "border-line"}`}>
              {t}
            </button>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="mb-1 font-semibold">Shared links</h2>
        <p className="mb-3 text-sm text-ink-2">Links you created, and how often each was opened.</p>
        {shares === null ? <p className="text-sm text-ink-3">Loading…</p> : null}
        {shares && !shares.length ? <p className="text-sm text-ink-3">Nothing shared.</p> : null}
        <ul className="divide-y divide-line">
          {shares?.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{label(s)}</p>
                <p className="text-xs text-ink-3">
                  {s.active ? "Active" : s.revoked_at ? "Turned off" : "Expired"} · opened {s.open_count} {s.open_count === 1 ? "time" : "times"}
                  {s.expires_at && s.active ? ` · until ${new Date(s.expires_at).toLocaleDateString()}` : ""}
                </p>
              </div>
              {s.active ? (
                <Button
                  kind="ghost"
                  onClick={async () => {
                    try {
                      const r = await api.revokeShare(s.id)
                      setShares((cur) => cur?.map((x) => (x.id === s.id ? { ...x, ...r.share, active: false } : x)) ?? null)
                      notify("Link turned off")
                    } catch {
                      notify("Could not turn off the link", "error")
                    }
                  }}
                >
                  Turn off
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-4">
        <h2 className="mb-1 font-semibold">Your data</h2>
        <p className="mb-3 text-sm text-ink-2">Download everything as JSON: items, tags, collections and links to your files (valid 24 hours).</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={exportAll} disabled={exporting}>
            {exporting ? "Preparing…" : "Export all data"}
          </Button>
          <Button onClick={onSignOut}>Sign out</Button>
        </div>
      </section>

      <section className="rounded-2xl border border-danger/40 bg-panel p-4">
        <h2 className="mb-1 font-semibold text-danger">Delete account</h2>
        <p className="mb-3 text-sm text-ink-2">Removes your account, every item and every file. This cannot be undone.</p>
        <Button kind="danger" onClick={onDeleteAccount}>
          Delete my account…
        </Button>
      </section>
    </div>
  )
}
