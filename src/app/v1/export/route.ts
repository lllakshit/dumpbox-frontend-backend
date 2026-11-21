import { z } from "zod"
import { requireUser } from "@/lib/api/auth"
import { BUCKET } from "@/lib/api/files"
import { fromDb, handler, ok, searchParams } from "@/lib/api/http"
import { ITEM_SELECT, toApiItem, type ItemRow } from "@/lib/api/items"

const PAGE = 500
const LINK_SECONDS = 24 * 60 * 60

/**
 * GET /v1/export?page=0 — everything in the account as JSON, in pages of 500 items (trash included) so each
 * response stays small. Page 0 also carries tags and collections. Keep reading while `next_page` is not null.
 * File details include download links valid for 24 hours.
 */
export const GET = handler(async (request: Request) => {
  const { db } = await requireUser(request)
  const page = z.coerce.number().int().min(0).max(100_000).default(0).parse(searchParams(request).get("page") ?? undefined)

  const { data, error } = await db
    .from("items")
    .select(ITEM_SELECT)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(page * PAGE, page * PAGE + PAGE)
  if (error) throw fromDb(error)
  const rows = (data as unknown as ItemRow[]).slice(0, PAGE)
  const hasMore = (data?.length ?? 0) > PAGE

  const ids = rows.map((r) => r.id)
  const paths = new Map<string, string>()
  for (let i = 0; i < ids.length; i += 200) {
    const { data: files, error: fe } = await db.from("files").select("id,storage_path").in("item_id", ids.slice(i, i + 200))
    if (fe) throw fromDb(fe)
    for (const f of files ?? []) paths.set(f.id as string, f.storage_path as string)
  }
  const links = new Map<string, string>()
  const all = [...paths.values()]
  for (let i = 0; i < all.length; i += 500) {
    const { data: signed } = await db.storage.from(BUCKET).createSignedUrls(all.slice(i, i + 500), LINK_SECONDS, { download: true })
    for (const s of signed ?? []) if (s.path && s.signedUrl) links.set(s.path, s.signedUrl)
  }

  let tags: unknown[] | undefined
  let collections: unknown[] | undefined
  if (page === 0) {
    const [t, c] = await Promise.all([
      db.from("tags").select("id,name,color,created_at").order("name"),
      db.from("collections").select("id,name,description,created_at").order("name"),
    ])
    if (t.error) throw fromDb(t.error)
    if (c.error) throw fromDb(c.error)
    tags = t.data ?? []
    collections = c.data ?? []
  }

  return ok({
    format: "dumpbox-export",
    version: 1,
    exported_at: new Date().toISOString(),
    page,
    next_page: hasMore ? page + 1 : null,
    items: rows.map((r) => {
      const item = toApiItem(r)
      return { ...item, files: item.files.map((f) => ({ ...f, download_url: links.get(paths.get(f.id) ?? "") ?? null })) }
    }),
    ...(tags ? { tags, collections } : {}),
  })
})
