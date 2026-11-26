"use client"
import { useEffect, useState } from "react"
import { emailApi, type ImportKey } from "@/lib/client/email"
import { Button } from "../app/ui"

const SCRIPT_PATH = "/dumpbox-gmail.gs"

/** The Gmail script with this key and this site's address filled in, ready to paste into script.google.com. */
async function filledScript(key: string, apiUrl: string) {
  const res = await fetch(SCRIPT_PATH, { cache: "no-store" })
  if (!res.ok) throw new Error("Could not load the script")
  return (await res.text()).replace("PASTE_IMPORT_KEY", key).replace("https://dumpbox-app.vercel.app", apiUrl)
}

/** Settings → Email: import keys for the Gmail script and how to set it up. */
export function EmailSettings({ notify }: { notify: (text: string, tone?: "ok" | "error") => void }) {
  const [keys, setKeys] = useState<ImportKey[] | null>(null)
  const [fresh, setFresh] = useState<{ key: string; api_url: string } | null>(null)
  const [label, setLabel] = useState("Gmail script")
  const [busy, setBusy] = useState(false)

  const load = () =>
    emailApi
      .keys()
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys([]))
  useEffect(() => {
    load()
  }, [])

  const make = async () => {
    setBusy(true)
    try {
      const r = await emailApi.createKey(label.trim() || "Gmail script")
      setFresh({ key: r.key, api_url: r.api_url })
      await load()
    } catch {
      notify("Could not make the key", "error")
    } finally {
      setBusy(false)
    }
  }
  const off = async (k: ImportKey) => {
    if (!window.confirm(`Turn off “${k.label}”? The script using it stops importing. Mail already in DumpBox stays.`)) return
    setBusy(true)
    try {
      await emailApi.deleteKey(k.id)
      notify("Key turned off", "ok")
      await load()
    } catch {
      notify("Could not turn it off", "error")
    } finally {
      setBusy(false)
    }
  }
  const copyScript = async () => {
    if (!fresh) return
    try {
      await navigator.clipboard.writeText(await filledScript(fresh.key, fresh.api_url))
      notify("Script copied with your key in it", "ok")
    } catch {
      notify("Could not copy. Use Download instead.", "error")
    }
  }
  const downloadScript = async () => {
    if (!fresh) return
    try {
      const blob = new Blob([await filledScript(fresh.key, fresh.api_url)], { type: "text/plain" })
      const a = document.createElement("a")
      a.href = URL.createObjectURL(blob)
      a.download = "dumpbox-gmail.gs"
      a.click()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    } catch {
      notify("Could not download the script", "error")
    }
  }

  return (
    <section id="email-settings" className="mx-auto w-full max-w-2xl space-y-4 px-3 pb-10 md:px-6">
      <h2 className="border-t border-line pt-6 text-base font-semibold">Email (Gmail)</h2>
      <p className="text-sm text-ink-2">
        A small script in your own Google account sends the Gmail labels you choose to the Email section here, every 10 minutes. Conversations keep their
        labels, star, importance and your priority labels (P1/P2/P3). Gmail is never changed, and nothing is read except the labels you list.
      </p>

      <ol className="list-decimal space-y-1 pl-5 text-sm text-ink-2">
        <li>Make an import key below, then press <b>Copy script</b> (your key is filled in).</li>
        <li>
          Open{" "}
          <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener noreferrer" className="text-accent underline">
            script.google.com → New project
          </a>
          , replace everything in <code>Code.gs</code> with the script, and save.
        </li>
        <li>
          In <code>CONFIG</code>, list your labels in <code>SYNC_LABELS</code> and your priority labels in <code>PRIORITY</code>.
        </li>
        <li>
          Choose <code>fullSync</code> → <b>Run</b>, and allow access (it is your own script: Advanced → Go to project). Run it again if the log says “paused”.
        </li>
        <li>
          Choose <code>installTriggers</code> → <b>Run</b>. From then on it runs by itself.
        </li>
      </ol>

      <div className="rounded-xl border border-line p-3 text-sm">
        <p className="font-medium">Import keys</p>
        <p className="mt-1 text-ink-2">A key can only add or update mail in your Email section; it cannot read anything. Turn off any you no longer use.</p>
        {keys?.length ? (
          <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center gap-2 px-3 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{k.label}</span>
                  <span className="block text-xs text-ink-3">
                    Made {k.created_at.slice(0, 10)}
                    {k.last_used_at ? ` · last import ${new Date(k.last_used_at).toLocaleString()}` : " · not used yet"}
                  </span>
                </span>
                <Button kind="ghost" onClick={() => off(k)} disabled={busy}>
                  Turn off
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-3">{keys ? "None yet." : "Loading…"}</p>
        )}

        {fresh ? (
          <div className="mt-3 rounded-xl bg-accent-soft p-3">
            <p className="text-xs font-medium">New key (shown only once)</p>
            <label htmlFor="email-key" className="sr-only">
              Import key
            </label>
            <input id="email-key" readOnly value={fresh.key} onFocus={(e) => e.target.select()} className="mt-1 w-full rounded-xl border border-line bg-bg px-3 py-1.5 font-mono text-xs" />
            <div className="mt-2 flex flex-wrap gap-2">
              <Button kind="primary" onClick={copyScript}>
                Copy script
              </Button>
              <Button onClick={downloadScript}>Download script</Button>
              <Button onClick={() => navigator.clipboard.writeText(fresh.key).then(() => notify("Key copied", "ok"))}>Copy key only</Button>
            </div>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label htmlFor="email-key-label" className="sr-only">
            Used by
          </label>
          <input id="email-key-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Used by (e.g. Personal Gmail)" className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-1.5 text-sm" />
          <Button onClick={make} disabled={busy}>
            Make import key
          </Button>
        </div>
      </div>
    </section>
  )
}
