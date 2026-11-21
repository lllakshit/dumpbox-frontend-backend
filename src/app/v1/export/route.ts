import { requireUser } from "@/lib/api/auth"
import { BUCKET } from "@/lib/api/files"
import { fromDb, handler, ok } from "@/lib/api/http"
import { ITEM_SELECT, toApiItem, type ItemRow } from "@/lib/api/items"

const PAGE = 1000
const LINK_SECONDS = 24 * 60 * 60

/**
 * GET /v1/export — everything in the account as one JSON document: items (trash included), tags, collections and
 * file details with download links valid for 24 hours.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)

  const rows: ItemRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("items")
      .select(ITEM_SELECT)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw fromDb(error)
    rows.push(...(data as unknown as ItemRow[]))
    if (!data || data.length < PAGE) break
  }

  const [tags, collections, files] = await Promise.all([
    db.from("tags").select("id,name,color,created_at").order("name"),
    db.from("collections").select("id,name,description,created_at").order("name"),
    db.from("files").select("id,storage_path"),
  ])
  if (tags.error) throw fromDb(tags.error)
  if (collections.error) throw fromDb(collections.error)
  if (files.error) throw fromDb(files.error)

  const links = new Map<string, string>()
  const paths = (files.data ?? []).map((f) => f.storage_path as string)
  for (let i = 0; i < paths.length; i += 500) {
    const { data } = await db.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 500), LINK_SECONDS, { download: true })
    for (const s of data ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl)
  }
  const pathById = new Map((files.data ?? []).map((f) => [f.id as string, f.storage_path as string]))

  const exportedAt = new Date().toISOString()
  return ok(
    {
      format: "dumpbox-export",
      version: 1,
      exported_at: exportedAt,
      items: rows.map((r) => {
        const item = toApiItem(r)
        return { ...item, files: item.files.map((f) => ({ ...f, download_url: links.get(pathById.get(f.id) ?? "") ?? null })) }
      }),
      tags: tags.data ?? [],
      collections: collections.data ?? [],
    },
    200,
    { "Content-Disposition": `attachment; filename="dumpbox-export-${exportedAt.slice(0, 10)}.json"` },
  )
})
