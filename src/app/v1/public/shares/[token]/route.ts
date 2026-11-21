import { BUCKET } from "@/lib/api/files"
import { ApiError, handler, ok } from "@/lib/api/http"
import { hashShareToken, SHARE_TOKEN_RE } from "@/lib/api/share-token"
import { isValidFilePath } from "@/lib/api/storage-admin"
import { adminClient } from "@/lib/supabase/server"

/** Fields a share recipient may see. Owner ids, tags, collections and other items are never returned. */
const PUBLIC_ITEM_SELECT =
  "id,type,title,body,url,link_title,link_description,link_image_url,link_site,latitude,longitude,location_label,created_at,deleted_at,files(id,file_name,mime_type,size_bytes,width,height,storage_path)"
const SIGNED_SECONDS = 10 * 60
const MAX_COLLECTION_ITEMS = 200

type PublicRow = {
  id: string
  type: string
  title: string | null
  body: string | null
  url: string | null
  link_title: string | null
  link_description: string | null
  link_image_url: string | null
  link_site: string | null
  latitude: number | null
  longitude: number | null
  location_label: string | null
  created_at: string
  deleted_at: string | null
  files: { id: string; file_name: string; mime_type: string; size_bytes: number; width: number | null; height: number | null; storage_path: string }[]
}

/**
 * GET /v1/public/shares/{token} — no sign-in. Uses the server key, so every access rule is checked here:
 * the token must match, not be revoked or expired, and only the shared item (or the shared collection's items)
 * is returned. Unknown, revoked and expired links all answer the same way.
 */
export const GET = handler(async (_request: Request, ctx: RouteContext<"/v1/public/shares/[token]">) => {
  const { token } = await ctx.params
  const notFound = new ApiError("not_found", "This link does not exist or has been turned off")
  if (!SHARE_TOKEN_RE.test(token)) throw notFound

  const admin = adminClient()
  const { data: share, error } = await admin
    .from("share_links")
    .select("id,user_id,item_id,collection_id,allow_download,expires_at,revoked_at")
    .eq("token_hash", hashShareToken(token))
    .maybeSingle()
  if (error) throw new ApiError("internal_error", "Could not open the link")
  if (!share || share.revoked_at || (share.expires_at && new Date(share.expires_at).getTime() <= Date.now())) throw notFound

  let rows: PublicRow[] = []
  let collectionName: string | null = null
  if (share.item_id) {
    const { data } = await admin
      .from("items")
      .select(PUBLIC_ITEM_SELECT)
      .eq("id", share.item_id)
      .eq("user_id", share.user_id)
      .is("deleted_at", null)
      .maybeSingle()
    if (!data) throw notFound
    rows = [data as unknown as PublicRow]
  } else if (share.collection_id) {
    const { data: col } = await admin
      .from("collections")
      .select("name")
      .eq("id", share.collection_id)
      .eq("user_id", share.user_id)
      .maybeSingle()
    if (!col) throw notFound
    collectionName = col.name as string
    const { data } = await admin
      .from("items")
      .select(`${PUBLIC_ITEM_SELECT},item_collections!inner(collection_id)`)
      .eq("item_collections.collection_id", share.collection_id)
      .eq("user_id", share.user_id)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(MAX_COLLECTION_ITEMS)
    rows = (data ?? []) as unknown as PublicRow[]
  }

  // Count the open; a failure here must not block the recipient.
  await admin.rpc("count_share_open", { p_id: share.id })

  const bucket = admin.storage.from(BUCKET)
  const items = await Promise.all(
    rows.map(async (r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      url: r.url,
      link: r.url ? { title: r.link_title, description: r.link_description, image_url: r.link_image_url, site: r.link_site } : null,
      location: r.latitude != null && r.longitude != null ? { latitude: r.latitude, longitude: r.longitude, label: r.location_label } : null,
      created_at: r.created_at,
      files: await Promise.all(
        (r.files ?? []).map(async (f) => {
          // Sign only paths that match the strict owner/item/file shape (no "..", no other folders).
          const safe = isValidFilePath(f.storage_path, share.user_id as string, r.id, f.id)
          // View-only links show images, audio, video and PDFs in the page; other files are not offered.
          const viewable = /^(image\/(png|jpe?g|gif|webp|avif|heic)|audio\/|video\/|application\/pdf$)/i.test(f.mime_type)
          const view = safe && (share.allow_download || viewable) ? await bucket.createSignedUrl(f.storage_path, SIGNED_SECONDS) : null
          const download = safe && share.allow_download
            ? await bucket.createSignedUrl(f.storage_path, SIGNED_SECONDS, { download: f.file_name })
            : null
          return {
            id: f.id,
            file_name: f.file_name,
            mime_type: f.mime_type,
            size_bytes: f.size_bytes,
            width: f.width,
            height: f.height,
            view_url: view?.data?.signedUrl ?? null,
            download_url: download?.data?.signedUrl ?? null,
          }
        }),
      ),
    })),
  )

  return ok(
    { kind: share.item_id ? "item" : "collection", collection_name: collectionName, allow_download: share.allow_download, items },
    200,
    { "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" },
  )
})
