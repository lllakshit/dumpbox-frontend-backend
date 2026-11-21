"use client"
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react"
import { Icon } from "./icons"

export type Capture =
  | { kind: "text"; text: string }
  | { kind: "files"; files: File[]; caption: string }
  | { kind: "place"; latitude: number; longitude: number; label: string }

const MAX_FILES = 10

/** Bottom capture bar: type and press Enter, attach/paste/drop files, or drop your current location. */
export function Composer({ onCapture, disabled }: { onCapture: (c: Capture) => void; disabled?: boolean }) {
  const [text, setText] = useState("")
  const [files, setFiles] = useState<File[]>([])
  const [locating, setLocating] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const el = area.current
    if (!el) return
    el.style.height = "auto"
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text])

  // Files dropped anywhere on the page land here.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return
      e.preventDefault()
      addFiles([...e.dataTransfer.files])
    }
    window.addEventListener("dragover", over)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragover", over)
      window.removeEventListener("drop", drop)
    }
  }, [])

  // Global shortcut: "/" focuses capture unless the user is typing somewhere.
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (e.key === "n" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
        e.preventDefault()
        area.current?.focus()
      } else if (e.key === "/" && !/input|textarea|select/i.test(t.tagName) && !t.isContentEditable) {
        e.preventDefault()
        area.current?.focus()
      }
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [])

  function addFiles(list: File[]) {
    setFiles((cur) => {
      const next = [...cur, ...list].slice(0, MAX_FILES)
      if (cur.length + list.length > MAX_FILES) setNote(`Up to ${MAX_FILES} files at a time`)
      return next
    })
  }

  function send() {
    const t = text.trim()
    if (files.length) {
      onCapture({ kind: "files", files, caption: t })
      setFiles([])
      setText("")
    } else if (t) {
      onCapture({ kind: "text", text: t })
      setText("")
    }
    setNote(null)
    area.current?.focus()
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = [...e.clipboardData.files]
    if (pasted.length) {
      e.preventDefault()
      addFiles(pasted)
    }
  }

  function locate() {
    if (!("geolocation" in navigator)) {
      setNote("Location is not available in this browser")
      return
    }
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false)
        onCapture({ kind: "place", latitude: pos.coords.latitude, longitude: pos.coords.longitude, label: text.trim() })
        setText("")
      },
      (err) => {
        setLocating(false)
        setNote(err.code === err.PERMISSION_DENIED ? "Location permission was denied" : "Could not get your location")
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    )
  }

  const canSend = !disabled && (text.trim().length > 0 || files.length > 0)

  return (
    <div className="border-t border-line bg-panel/95 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:px-6">
      {files.length ? (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label="Files to send">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex max-w-56 items-center gap-2 rounded-lg border border-line bg-bg px-2 py-1 text-xs">
              <Icon.file width={14} height={14} />
              <span className="truncate">{f.name}</span>
              <button onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                <Icon.close width={12} height={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="mb-1 text-xs text-warn">{note}</p> : null}
      <div className="flex items-end gap-1.5">
        <button onClick={() => picker.current?.click()} className="rounded-xl p-2.5 text-ink-2 hover:bg-panel-2" aria-label="Attach files" title="Attach files">
          <Icon.attach />
        </button>
        <button onClick={locate} disabled={locating} className="rounded-xl p-2.5 text-ink-2 hover:bg-panel-2 disabled:opacity-50" aria-label="Add current location" title="Add current location">
          <Icon.place />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])])
            e.target.value = ""
          }}
        />
        <label htmlFor="capture" className="sr-only">
          Dump something
        </label>
        <textarea
          id="capture"
          ref={area}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={files.length ? "Add a caption (optional)" : "Dump anything…"}
          className="max-h-56 min-h-11 flex-1 resize-none rounded-2xl border border-line bg-bg px-3.5 py-2.5 text-base leading-snug outline-none focus:border-accent"
        />
        <button onClick={send} disabled={!canSend} className="rounded-xl bg-accent p-2.5 text-accent-ink disabled:opacity-40" aria-label="Send">
          <Icon.send />
        </button>
      </div>
      <p className="mt-1 hidden text-[11px] text-ink-3 md:block">Enter to send · Shift+Enter for a new line · paste or drop files · press / to focus</p>
    </div>
  )
}

/** A single bare URL becomes a link item; anything else is a note. */
export function classifyText(text: string): { type: "link"; url: string } | { type: "note" } {
  const t = text.trim()
  if (/^https?:\/\/\S+$/i.test(t)) {
    try {
      const u = new URL(t)
      if (u.protocol === "http:" || u.protocol === "https:") return { type: "link", url: t }
    } catch {
      // not a URL
    }
  }
  return { type: "note" }
}
