import { api } from "@/lib/client/api"

/** Signed file URLs are cached for 50 minutes (they are valid for 60). */
const urlCache = new Map<string, { view: string; download: string; at: number }>()
export async function fileUrls(id: string) {
  const hit = urlCache.get(id)
  if (hit && Date.now() - hit.at < 50 * 60_000) return hit
  const r = await api.fileUrls(id)
  const v = { view: r.view_url, download: r.download_url, at: Date.now() }
  urlCache.set(id, v)
  return v
}
