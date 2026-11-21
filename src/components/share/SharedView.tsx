"use client"
import { useEffect, useState } from "react"
import { useParams } from "next/navigation"
import { formatBytes, Linkified } from "@/components/app/ui"

type SharedFile = { id: string; file_name: string; mime_type: string; size_bytes: number; view_url: string | null; download_url: string | null }
type SharedItem = {
  id: string
  type: string
  title: string | null
  body: string | null
  url: string | null
  link: { title: string | null; description: string | null; image_url: string | null; site: string | null } | null
  location: { latitude: number; longitude: number; label: string | null } | null
  created_at: string
  files: SharedFile[]
}
type Data = { kind: "item" | "collection"; collection_name: string | null; allow_download: boolean; items: SharedItem[] }

export function SharedView() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/v1/public/shares/${encodeURIComponent(token)}`, { referrerPolicy: "no-referrer" })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j?.error?.message ?? "This link does not work")
        setData(j)
      })
      .catch((e) => setError(e instanceof Error ? e.message : "This link does not work"))
  }, [token])

  return (
    <main className="mx-auto min-h-full max-w-2xl px-4 py-8">
      <header className="mb-6 flex items-center gap-2">
        <div className="grid h-8 w-8 place-items-center rounded-xl bg-accent font-bold text-accent-ink" aria-hidden="true">
          D
        </div>
        <p className="text-sm text-ink-2">Shared with you from DumpBox</p>
      </header>
      {error ? <p className="rounded-xl bg-danger-soft p-4 text-danger">{error}</p> : null}
      {!data && !error ? <p className="text-ink-3">Opening…</p> : null}
      {data ? (
        <>
          {data.kind === "collection" ? <h1 className="mb-4 text-2xl font-semibold">{data.collection_name}</h1> : null}
          {data.kind === "collection" && !data.items.length ? <p className="text-ink-2">This collection is empty.</p> : null}
          <ul className="space-y-3">
            {data.items.map((it) => (
              <li key={it.id} className="rounded-2xl border border-line bg-panel p-4 shadow-[var(--shadow)]">
                {it.title ? <h2 className="mb-1 font-semibold">{it.title}</h2> : null}
                {it.body ? (
                  <p className="whitespace-pre-wrap break-words">
                    <Linkified text={it.body} />
                  </p>
                ) : null}
                {it.url ? (
                  <a href={it.url} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 block rounded-xl border border-line p-3 hover:border-accent">
                    <p className="text-xs text-ink-3">{it.link?.site}</p>
                    <p className="font-medium break-words">{it.link?.title ?? it.url}</p>
                    {it.link?.description ? <p className="mt-1 text-sm text-ink-2">{it.link.description}</p> : null}
                  </a>
                ) : null}
                {it.location ? (
                  <a
                    className="mt-2 block text-accent underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    href={`https://www.openstreetmap.org/?mlat=${it.location.latitude}&mlon=${it.location.longitude}#map=17/${it.location.latitude}/${it.location.longitude}`}
                  >
                    {it.location.label ?? "Location"} ({it.location.latitude.toFixed(5)}, {it.location.longitude.toFixed(5)})
                  </a>
                ) : null}
                {it.files.map((f) => (
                  <div key={f.id} className="mt-2">
                    {f.mime_type.startsWith("image/") && f.view_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={f.view_url} alt={f.file_name} className="max-h-[480px] w-full rounded-xl object-contain" />
                    ) : null}
                    <div className="mt-1 flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">
                        {f.file_name} <span className="text-ink-3">· {formatBytes(f.size_bytes)}</span>
                      </span>
                      <span className="flex shrink-0 gap-3">
                        {f.view_url ? (
                          <a href={f.view_url} target="_blank" rel="noopener noreferrer" className="text-accent underline">
                            Open
                          </a>
                        ) : null}
                        {f.download_url ? (
                          <a href={f.download_url} className="text-accent underline">
                            Download
                          </a>
                        ) : null}
                      </span>
                    </div>
                  </div>
                ))}
                <p className="mt-2 text-xs text-ink-3">{new Date(it.created_at).toLocaleString()}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </main>
  )
}
