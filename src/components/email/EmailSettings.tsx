"use client"
import { useEffect, useState } from "react"
import { emailApi, type ImportKey } from "@/lib/client/email"
import { cleanLabels, DEFAULT_SCRIPT_CONFIG, fillScript, type ScriptConfig } from "@/lib/email/script-config"
import { Button } from "../app/ui"

const SCRIPT_PATH = "/dumpbox-gmail.gs"
const CONFIG_KEY = "dumpbox.email.scriptConfig"

/** The Gmail script with the key, this site's address and the labels below filled in: paste and run, no editing. */
async function filledScript(key: string, apiUrl: string, cfg: ScriptConfig) {
  const res = await fetch(SCRIPT_PATH, { cache: "no-store" })
  if (!res.ok) throw new Error("Could not load the script")
  return fillScript(await res.text(), key, apiUrl, cfg)
}

function readConfig(): ScriptConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null") as Partial<ScriptConfig> | null
    if (saved && Array.isArray(saved.syncLabels) && Array.isArray(saved.priority)) return { ...DEFAULT_SCRIPT_CONFIG, ...saved } as ScriptConfig
  } catch {
    // fall back to the default setup
  }
  return DEFAULT_SCRIPT_CONFIG
}

const field = "w-full rounded-xl border border-line bg-bg px-3 py-1.5 text-sm"

/** Settings → Email: import keys for the Gmail script and how to set it up. */
export function EmailSettings({ notify }: { notify: (text: string, tone?: "ok" | "error") => void }) {
  const [keys, setKeys] = useState<ImportKey[] | null>(null)
  const [fresh, setFresh] = useState<{ key: string; api_url: string } | null>(null)
  const [label, setLabel] = useState("Gmail script")
  const [busy, setBusy] = useState(false)
  // Settings only renders after sign-in on the client, so reading browser storage on first render is safe.
  const [cfg, setCfgState] = useState<ScriptConfig>(readConfig)
  const [labelsText, setLabelsText] = useState(() => cfg.syncLabels.join("\n"))
  const setCfg = (patch: Partial<ScriptConfig>) =>
    setCfgState((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(next))
      } catch {
        // private window: kept for this visit only
      }
      return next
    })

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
      await navigator.clipboard.writeText(await filledScript(fresh.key, fresh.api_url, cfg))
      notify("Script copied with your key and labels in it", "ok")
    } catch (e) {
      notify(e instanceof Error && e.message.startsWith("The Gmail script") ? e.message : "Could not copy. Use Download instead.", "error")
    }
  }
  const downloadScript = async () => {
    if (!fresh) return
    try {
      const blob = new Blob([await filledScript(fresh.key, fresh.api_url, cfg)], { type: "text/plain" })
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
        <li>Check the labels below, make an import key, then press <b>Copy script</b> (key and labels are filled in).</li>
        <li>
          Open{" "}
          <a href="https://script.google.com/home/projects/create" target="_blank" rel="noopener noreferrer" className="text-accent underline">
            script.google.com → New project
          </a>
          , replace everything in <code>Code.gs</code> with the script, and save.
        </li>
        <li>
          Choose <code>fullSync</code> → <b>Run</b>, and allow access (it is your own script: Advanced → Go to project). Run it again if the log says “paused”.
        </li>
        <li>
          Choose <code>installTriggers</code> → <b>Run</b>. From then on it runs by itself.
        </li>
      </ol>

      <div className="rounded-xl border border-line p-3 text-sm">
        <p className="font-medium">What to bring in</p>
        <p className="mt-1 text-ink-2">Exact Gmail label names, one per line. A parent label brings its sub-labels. Very large labels (thousands of mails) slow the first import and fill storage.</p>
        <label htmlFor="email-sync-labels" className="mt-2 block text-xs font-medium text-ink-2">
          Labels
        </label>
        <textarea
          id="email-sync-labels"
          rows={Math.min(10, Math.max(4, labelsText.split("\n").length + 1))}
          value={labelsText}
          onChange={(e) => {
            setLabelsText(e.target.value)
            setCfg({ syncLabels: cleanLabels(e.target.value) })
          }}
          className={`${field} mt-1 font-mono text-xs`}
        />
        <p className="mt-3 text-xs font-medium text-ink-2">Priority labels (also brought in)</p>
        <div className="mt-1 grid gap-2 sm:grid-cols-3">
          {(["High", "Medium", "Low"] as const).map((name, i) => (
            <div key={name}>
              <label htmlFor={`email-priority-${i}`} className="block text-xs text-ink-3">
                {name}
              </label>
              <input
                id={`email-priority-${i}`}
                value={cfg.priority[i]}
                placeholder="(not used)"
                onChange={(e) => {
                  const p = [...cfg.priority] as ScriptConfig["priority"]
                  p[i] = e.target.value
                  setCfg({ priority: p })
                }}
                className={field}
              />
            </div>
          ))}
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!cfg.sendAllLabels} onChange={(e) => setCfg({ sendAllLabels: !e.target.checked })} />
          Show only these labels on each conversation (hides your other Gmail labels)
        </label>
        <button
          type="button"
          className="mt-2 text-xs text-accent hover:underline"
          onClick={() => {
            setCfg(DEFAULT_SCRIPT_CONFIG)
            setLabelsText(DEFAULT_SCRIPT_CONFIG.syncLabels.join("\n"))
          }}
        >
          Reset to the recommended setup
        </button>
      </div>

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
