/** Shapes returned by the /v1 API, shared by the web client. */
export type ItemType = "note" | "link" | "file" | "image" | "location" | "voice"

export type FileMeta = {
  id: string
  file_name: string
  mime_type: string
  size_bytes: number
  sha256: string | null
  width: number | null
  height: number | null
  created_at: string
}

export type Item = {
  id: string
  type: ItemType
  title: string | null
  body: string | null
  source: string
  url: string | null
  link: { title: string | null; description: string | null; image_url: string | null; site: string | null } | null
  location: { latitude: number; longitude: number; label: string | null } | null
  pinned: boolean
  starred: boolean
  archived_at: string | null
  deleted_at: string | null
  version: number
  created_at: string
  updated_at: string
  tags: { id: string; name: string; color: string | null }[]
  collection_ids: string[]
  files: FileMeta[]
}

export type Tag = { id: string; name: string; color: string | null; item_count: number }
export type Collection = { id: string; name: string; description: string | null; item_count: number }
export type Share = {
  id: string
  item_id: string | null
  collection_id: string | null
  allow_download: boolean
  expires_at: string | null
  open_count: number
  last_opened_at: string | null
  revoked_at: string | null
  created_at: string
  active: boolean
  items?: { title: string | null; body: string | null; type: string; link_title: string | null; url: string | null } | null
  collections?: { name: string } | null
}

/** What the feed is showing. */
export type View =
  | { kind: "feed" }
  | { kind: "pinned" }
  | { kind: "starred" }
  | { kind: "archived" }
  | { kind: "trash" }
  | { kind: "type"; type: ItemType }
  | { kind: "tag"; id: string; name: string }
  | { kind: "collection"; id: string; name: string }

export function viewQuery(v: View): string {
  switch (v.kind) {
    case "feed":
    case "pinned":
    case "starred":
    case "archived":
    case "trash":
      return `view=${v.kind}`
    case "type":
      return `type=${v.type}`
    case "tag":
      return `tag=${v.id}`
    case "collection":
      return `collection=${v.id}`
  }
}

/** Does an item belong in a view? Used to place items that arrive through sync. */
export function inView(item: Item, v: View): boolean {
  const live = !item.deleted_at
  switch (v.kind) {
    case "feed":
      return live && !item.archived_at
    case "pinned":
      return live && item.pinned
    case "starred":
      return live && item.starred
    case "archived":
      return live && Boolean(item.archived_at)
    case "trash":
      return !live
    case "type":
      return live && !item.archived_at && item.type === v.type
    case "tag":
      return live && !item.archived_at && item.tags.some((t) => t.id === v.id)
    case "collection":
      return live && !item.archived_at && item.collection_ids.includes(v.id)
  }
}

export const viewTitle = (v: View): string =>
  ({
    feed: "Feed",
    pinned: "Pinned",
    starred: "Starred",
    archived: "Archive",
    trash: "Trash",
    type: v.kind === "type" ? TYPE_LABEL[v.type] : "",
    tag: v.kind === "tag" ? `#${v.name}` : "",
    collection: v.kind === "collection" ? v.name : "",
  })[v.kind]

export const TYPE_LABEL: Record<ItemType, string> = {
  note: "Notes",
  link: "Links",
  image: "Images",
  file: "Documents",
  location: "Places",
  voice: "Voice",
}
