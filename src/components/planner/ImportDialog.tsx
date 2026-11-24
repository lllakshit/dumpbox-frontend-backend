"use client"
import { useState } from "react"
import { plannerApi, type ImportSummary, type Planner } from "@/lib/client/planner"
import { ApiFailure } from "@/lib/client/api"
import { toWall } from "@/lib/planner/time"
import { Button, Modal } from "../app/ui"

const EXAMPLE = `{
  "events": [
    { "title": "Dentist", "date": "2026-12-01", "time": "10:00", "end_time": "11:00",
      "location": "City Clinic", "remind": ["1h", "10m"], "calendar": "Personal" },
    { "title": "Team standup", "date": "2026-12-01", "time": "9:30am", "duration": 15,
      "repeat": "weekdays", "remind": "5m" },
    { "title": "Goa trip", "date": "2026-12-20", "end": "2026-12-24", "all_day": true }
  ],
  "tasks": [
    { "title": "Pay rent", "due": "2026-12-01", "repeat": "monthly", "remind": "0" },
    { "title": "Renew passport", "due": "2027-01-15", "list": "Admin", "starred": true },
    { "title": "Call the bank", "due": "2026-11-26T11:00", "notes": "Ask about the card" }
  ]
}`

const MAX_FILE = 4 * 1024 * 1024

export function ImportDialog({ planner, onClose }: { planner: Planner; onClose: () => void }) {
  const [tab, setTab] = useState<"file" | "paste">("file")
  const [text, setText] = useState("")
  const [fileName, setFileName] = useState<string | null>(null)
  const [kind, setKind] = useState<"event" | "task">("event")
  const [calendarId, setCalendarId] = useState("")
  const [listId, setListId] = useState("")
  const [check, setCheck] = useState<ImportSummary | null>(null)
  const [done, setDone] = useState<ImportSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const body = (dry: boolean) => ({
    text,
    dry_run: dry,
    time_zone: planner.tz,
    default_kind: kind,
    default_event_minutes: planner.prefs.default_event_minutes,
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...(listId ? { list_id: listId } : {}),
  })

  const run = async (dry: boolean) => {
    if (!text.trim()) {
      setError("Choose a file or paste something first")
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await plannerApi.import(body(dry))
      if (dry) setCheck(r)
      else {
        setDone(r)
        await planner.sync()
      }
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Import failed")
    } finally {
      setBusy(false)
    }
  }

  const readFile = async (f: File) => {
    setError(null)
    setCheck(null)
    setDone(null)
    if (f.size > MAX_FILE) {
      setError("That file is over 4 MB. Split it into smaller files.")
      return
    }
    setFileName(f.name)
    setText(await f.text())
  }

  const fmt = (p: NonNullable<ImportSummary["preview"]>[number]) => {
    if (p.start_at) {
      const w = toWall(new Date(p.start_at), planner.tz)
      return `${w.date} ${w.time}${p.end_at ? `–${toWall(new Date(p.end_at), planner.tz).time}` : ""}`
    }
    if (p.start_date) return `${p.start_date}${p.end_date ? ` → ${p.end_date}` : ""}`
    return "No date"
  }

  return (
    <Modal title="Import events and tasks" onClose={onClose} wide>
      {done ? (
        <div className="space-y-3">
          <p className="text-sm">
            Imported <b>{done.created ?? 0}</b> new and updated <b>{done.updated ?? 0}</b> ({done.events} events, {done.tasks} tasks).
          </p>
          {done.errors.length ? <Problems errors={done.errors} /> : null}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                setDone(null)
                setCheck(null)
                setText("")
                setFileName(null)
              }}
            >
              Import more
            </Button>
            <Button kind="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="inline-flex rounded-xl border border-line p-0.5 text-sm" role="tablist">
            {(
              [
                ["file", "Upload a file"],
                ["paste", "Paste or run JSON"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-lg px-3 py-1.5 ${tab === k ? "bg-accent text-accent-ink" : "text-ink-2"}`}>
                {l}
              </button>
            ))}
          </div>

          {tab === "file" ? (
            <div
              className="rounded-xl border-2 border-dashed border-line p-6 text-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                const f = e.dataTransfer.files[0]
                if (f) readFile(f)
              }}
            >
              <p className="text-sm text-ink-2">Drop a .json, .ics or .txt file here, or</p>
              <label className="mt-2 inline-block cursor-pointer rounded-xl bg-accent px-3 py-2 text-sm font-medium text-accent-ink">
                Choose file
                <input type="file" accept=".json,.ics,.ical,.txt,application/json,text/calendar,text/plain" className="sr-only" onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
              </label>
              {fileName ? <p className="mt-2 text-sm">{fileName}</p> : null}
              <p className="mt-3 text-xs text-ink-3">Works with Google Calendar exports (.ics, or the API&apos;s JSON), Google Tasks JSON, a DumpBox export, your own JSON, or a text file with one item per line.</p>
            </div>
          ) : (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label htmlFor="imp-text" className="text-xs font-medium text-ink-2">
                  JSON, .ics text, or one event / task per line
                </label>
                <button type="button" onClick={() => setText(EXAMPLE)} className="text-xs text-accent">
                  Insert example
                </button>
              </div>
              <textarea
                id="imp-text"
                value={text}
                onChange={(e) => {
                  setText(e.target.value)
                  setCheck(null)
                }}
                rows={10}
                spellCheck={false}
                className="w-full rounded-xl border border-line bg-bg px-3 py-2 font-mono text-xs outline-none focus:border-accent"
                placeholder={'[{ "title": "Dentist", "date": "2026-12-01", "time": "10:00" }]\n\nor\n\nDentist tomorrow 5pm\nPay rent every 1st'}
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="imp-kind" className="mb-1 block text-xs font-medium text-ink-2">
                When the file does not say
              </label>
              <select id="imp-kind" value={kind} onChange={(e) => setKind(e.target.value as "event" | "task")} className="w-full rounded-xl border border-line bg-bg px-2 py-2 text-sm">
                <option value="event">Make events</option>
                <option value="task">Make tasks</option>
              </select>
            </div>
            <div>
              <label htmlFor="imp-cal" className="mb-1 block text-xs font-medium text-ink-2">
                Events go to
              </label>
              <select id="imp-cal" value={calendarId} onChange={(e) => setCalendarId(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-2 py-2 text-sm">
                <option value="">Calendar named in the file, else default</option>
                {planner.lists
                  .filter((l) => l.kind === "calendar")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="imp-list" className="mb-1 block text-xs font-medium text-ink-2">
                Tasks go to
              </label>
              <select id="imp-list" value={listId} onChange={(e) => setListId(e.target.value)} className="w-full rounded-xl border border-line bg-bg px-2 py-2 text-sm">
                <option value="">List named in the file, else default</option>
                {planner.lists
                  .filter((l) => l.kind === "tasks")
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>

          {error ? <p className="text-sm text-danger">{error}</p> : null}

          {check ? (
            <div className="space-y-2 rounded-xl border border-line p-3">
              <p className="text-sm">
                Found <b>{check.events}</b> events and <b>{check.tasks}</b> tasks <span className="text-ink-3">({check.format})</span>.
              </p>
              {check.preview?.length ? (
                <div className="scroll-thin max-h-56 overflow-y-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-ink-3">
                      <tr>
                        <th className="py-1 pr-2 font-medium">Type</th>
                        <th className="py-1 pr-2 font-medium">Title</th>
                        <th className="py-1 pr-2 font-medium">When</th>
                        <th className="py-1 font-medium">Repeat / remind</th>
                      </tr>
                    </thead>
                    <tbody>
                      {check.preview.slice(0, 100).map((p, i) => (
                        <tr key={i} className="border-t border-line">
                          <td className="py-1 pr-2">{p.kind}</td>
                          <td className="py-1 pr-2">{p.title}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{fmt(p)}</td>
                          <td className="py-1">
                            {p.rrule ? "↻ " : ""}
                            {p.reminders?.length ? `🔔 ${p.reminders.join(", ")} min` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {check.errors.length ? <Problems errors={check.errors} /> : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
            <div className="flex gap-2 text-sm">
              <span className="text-ink-3">Export:</span>
              <button className="text-accent" onClick={() => plannerApi.download("json").catch(() => setError("Export failed"))}>
                JSON
              </button>
              <button className="text-accent" onClick={() => plannerApi.download("ics").catch(() => setError("Export failed"))}>
                .ics
              </button>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => run(true)} disabled={busy || !text.trim()}>
                Check
              </Button>
              <Button kind="primary" onClick={() => run(false)} disabled={busy || !text.trim() || (check !== null && check.events + check.tasks === 0)}>
                {busy ? "Working…" : check ? `Import ${check.events + check.tasks}` : "Import"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  )
}

function Problems({ errors }: { errors: string[] }) {
  return (
    <details className="text-xs" open={errors.length <= 5}>
      <summary className="cursor-pointer text-warn">{errors.length} skipped or changed</summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-ink-2">
        {errors.slice(0, 100).map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </details>
  )
}
