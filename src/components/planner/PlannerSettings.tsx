"use client"
import { useEffect, useState } from "react"
import type { Planner } from "@/lib/client/planner"
import { call } from "@/lib/client/api"
import { REMINDER_CHOICES, reminderLabel } from "@/lib/planner/types"
import { Button } from "../app/ui"

const field = "rounded-xl border border-line bg-bg px-3 py-2 text-sm"

function ReminderPicker({ id, value, onChange, allDay }: { id: string; value: number[]; onChange: (v: number[]) => void; allDay?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {value.map((m) => (
        <button key={m} type="button" onClick={() => onChange(value.filter((x) => x !== m))} className="rounded-full border border-line bg-panel-2 px-2.5 py-1 text-xs" aria-label={`Remove ${reminderLabel(m, allDay)}`}>
          {reminderLabel(m, allDay)} ✕
        </button>
      ))}
      {value.length < 5 ? (
        <>
          <label htmlFor={id} className="sr-only">
            Add default notification
          </label>
          <select id={id} value="" onChange={(e) => e.target.value && onChange([...new Set([...value, Number(e.target.value)])].sort((a, b) => a - b))} className="rounded-full border border-dashed border-line bg-transparent px-2.5 py-1 text-xs text-accent">
            <option value="">+ Add</option>
            {REMINDER_CHOICES.filter((m) => !value.includes(m)).map((m) => (
              <option key={m} value={m}>
                {reminderLabel(m, allDay)}
              </option>
            ))}
          </select>
        </>
      ) : null}
      {!value.length ? <span className="text-xs text-ink-3">None</span> : null}
    </div>
  )
}

/** Calendar & tasks section of Settings. */
export function PlannerSettings({ planner, onImport }: { planner: Planner; onImport: () => void }) {
  const p = planner.prefs
  const [perm, setPerm] = useState<NotificationPermission | "unsupported">(() => (typeof Notification === "undefined" ? "unsupported" : Notification.permission))
  return (
    <section className="mx-auto w-full max-w-2xl space-y-5 px-3 pb-10 md:px-6">
      <h2 className="border-t border-line pt-6 text-base font-semibold">Calendar & tasks</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pp-week" className="mb-1 block text-xs font-medium text-ink-2">
            Week starts on
          </label>
          <select id="pp-week" value={p.week_start} onChange={(e) => planner.setPrefs({ week_start: Number(e.target.value) as 0 | 1 | 6 })} className={`${field} w-full`}>
            <option value={1}>Monday</option>
            <option value={0}>Sunday</option>
            <option value={6}>Saturday</option>
          </select>
        </div>
        <div>
          <label htmlFor="pp-len" className="mb-1 block text-xs font-medium text-ink-2">
            Default event length
          </label>
          <select id="pp-len" value={p.default_event_minutes} onChange={(e) => planner.setPrefs({ default_event_minutes: Number(e.target.value) })} className={`${field} w-full`}>
            {[15, 30, 45, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}`}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pp-allday" className="mb-1 block text-xs font-medium text-ink-2">
            All-day and date-only reminders at
          </label>
          <input id="pp-allday" type="time" value={p.all_day_reminder_time} onChange={(e) => e.target.value && planner.setPrefs({ all_day_reminder_time: e.target.value })} className={`${field} w-full`} />
        </div>
        <div>
          <p className="mb-1 text-xs font-medium text-ink-2">Time zone</p>
          <p className="py-2 text-sm">{planner.tz}</p>
        </div>
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-ink-2">Default notifications for new events</p>
        <ReminderPicker id="pp-ev" value={p.default_event_reminders} onChange={(v) => planner.setPrefs({ default_event_reminders: v })} />
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-ink-2">Default notifications for new tasks with a date</p>
        <ReminderPicker id="pp-task" value={p.default_task_reminders} onChange={(v) => planner.setPrefs({ default_task_reminders: v })} />
      </div>
      <div className="rounded-xl border border-line p-3 text-sm">
        <p className="font-medium">Notifications in this browser</p>
        <p className="mt-1 text-ink-2">
          {perm === "granted"
            ? "On. Reminders show as desktop notifications while DumpBox is open in a tab."
            : perm === "denied"
              ? "Blocked in your browser settings. Reminders show inside the page instead."
              : perm === "unsupported"
                ? "This browser cannot show notifications. Reminders show inside the page."
                : "Off. Turn on to get desktop notifications while DumpBox is open. The phone app notifies even when closed."}
        </p>
        {perm === "default" ? (
          <Button className="mt-2" kind="primary" onClick={async () => setPerm(await Notification.requestPermission())}>
            Turn on notifications
          </Button>
        ) : null}
      </div>
      <FeedAddress />
      <div className="flex flex-wrap gap-2">
        <Button onClick={onImport}>Import / export events and tasks</Button>
      </div>
    </section>
  )
}

type Address = { id: string; label: string; created_at: string; last_used_at: string | null }

/** Secret, read-only calendar addresses: one per device or calendar app (Google Calendar → Add from URL). */
function FeedAddress() {
  const [list, setList] = useState<Address[] | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [label, setLabel] = useState("Google Calendar")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const load = () =>
    call<{ addresses: Address[] }>("GET", "/v1/planner/feed-token")
      .then((r) => setList(r.addresses))
      .catch(() => setList([]))
  useEffect(() => {
    load()
  }, [])
  const make = async () => {
    setBusy(true)
    try {
      const r = await call<{ ics_url: string }>("POST", "/v1/planner/feed-token", { label: label.trim() || "Calendar app" })
      setUrl(r.ics_url)
      setMsg("Copy it now: it is shown only once.")
      await load()
    } catch {
      setMsg("Could not make the address")
    } finally {
      setBusy(false)
    }
  }
  const off = async (a: Address) => {
    setBusy(true)
    try {
      await call("DELETE", `/v1/planner/feed-token?id=${a.id}`)
      setMsg(`“${a.label}” turned off.`)
      await load()
    } catch {
      setMsg("Could not turn it off")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="rounded-xl border border-line p-3 text-sm">
      <p className="font-medium">Secret calendar addresses</p>
      <p className="mt-1 text-ink-2">
        Private, read-only links to your events and tasks (.ics). Add one in Google Calendar (Other calendars → From URL), Outlook or Apple Calendar to see DumpBox there. The phone app makes its own for reminders while it is closed. Anyone with a link can read your calendar; turn off any you no longer use.
      </p>
      {list?.length ? (
        <ul className="mt-2 divide-y divide-line rounded-xl border border-line">
          {list.map((a) => (
            <li key={a.id} className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate">{a.label}</span>
                <span className="block text-xs text-ink-3">
                  Made {a.created_at.slice(0, 10)}
                  {a.last_used_at ? ` · last read ${a.last_used_at.slice(0, 16).replace("T", " ")}` : " · not read yet"}
                </span>
              </span>
              <Button kind="ghost" onClick={() => off(a)} disabled={busy}>
                Turn off
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-ink-3">{list ? "None yet." : "Loading…"}</p>
      )}
      {url ? (
        <div className="mt-2 flex gap-2">
          <label htmlFor="feed-url" className="sr-only">
            Calendar address
          </label>
          <input id="feed-url" readOnly value={url} className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-1.5 font-mono text-xs" onFocus={(e) => e.target.select()} />
          <Button onClick={() => navigator.clipboard.writeText(url).then(() => setMsg("Copied"))}>Copy</Button>
        </div>
      ) : null}
      {msg ? <p className="mt-1 text-xs text-ink-2">{msg}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label htmlFor="feed-label" className="sr-only">
          Used by
        </label>
        <input id="feed-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Used by (e.g. Google Calendar)" className="min-w-0 flex-1 rounded-xl border border-line bg-bg px-3 py-1.5 text-sm" />
        <Button onClick={make} disabled={busy}>
          Make address
        </Button>
      </div>
    </div>
  )
}
