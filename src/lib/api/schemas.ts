import { z } from "zod"

export const ITEM_TYPES = ["note", "link", "file", "image", "location", "voice"] as const
export const SOURCES = ["web", "android", "ios", "desktop", "extension", "api"] as const
export type ItemType = (typeof ITEM_TYPES)[number]

const tagName = z.string().trim().min(1).max(50)
const httpUrl = z
  .string()
  .trim()
  .max(4000)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === "http:" || u.protocol === "https:"
    } catch {
      return false
    }
  }, "Must be an http(s) URL")

export const createItemSchema = z
  .object({
    /** Client-generated id makes retries from offline queues idempotent. */
    id: z.uuid().optional(),
    type: z.enum(ITEM_TYPES),
    title: z.string().max(500).nullish(),
    body: z.string().max(100_000).nullish(),
    url: httpUrl.nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    location_label: z.string().max(500).nullish(),
    source: z.enum(SOURCES).default("web"),
    /** When the item was captured on the device (offline captures keep their real time). */
    captured_at: z.iso.datetime({ offset: true }).optional(),
    pinned: z.boolean().optional(),
    starred: z.boolean().optional(),
    tags: z.array(tagName).max(20).optional(),
    collection_ids: z.array(z.uuid()).max(20).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === "note" && !v.body?.trim() && !v.title?.trim()) ctx.addIssue({ code: "custom", path: ["body"], message: "A note needs text" })
    if (v.type === "link" && !v.url) ctx.addIssue({ code: "custom", path: ["url"], message: "A link needs a url" })
    if (v.type === "location" && (v.latitude == null || v.longitude == null))
      ctx.addIssue({ code: "custom", path: ["latitude"], message: "A location needs latitude and longitude" })
  })
export type CreateItemInput = z.infer<typeof createItemSchema>

export const updateItemSchema = z
  .object({
    title: z.string().max(500).nullable().optional(),
    body: z.string().max(100_000).nullable().optional(),
    location_label: z.string().max(500).nullable().optional(),
    pinned: z.boolean().optional(),
    starred: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Version the client last saw; used to report whether the edit was merged with a newer change. */
    base_version: z.number().int().positive().optional(),
  })
  .refine((v) => Object.keys(v).some((k) => k !== "base_version"), "Nothing to update")

export const listItemsSchema = z.object({
  view: z.enum(["feed", "pinned", "starred", "archived", "trash"]).default("feed"),
  type: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.enum(ITEM_TYPES)).max(6).optional()),
  tag: z.uuid().optional(),
  collection: z.uuid().optional(),
  cursor: z.string().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(40),
})

export const searchSchema = z.object({
  q: z.string().max(200).default(""),
  type: listItemsSchema.shape.type,
  tags: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.uuid()).max(10).optional()),
  collection: z.uuid().optional(),
  starred: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  include_archived: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(5000).default(0),
})

export const setTagsSchema = z.object({ tags: z.array(tagName).max(20) })
export const setCollectionsSchema = z.object({ collection_ids: z.array(z.uuid()).max(50) })

export const tagSchema = z.object({
  name: tagName,
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullish(),
})
export const tagUpdateSchema = tagSchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update")

export const collectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).nullish(),
})
export const collectionUpdateSchema = collectionSchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update")

export const BULK_ACTIONS = [
  "pin",
  "unpin",
  "star",
  "unstar",
  "archive",
  "unarchive",
  "delete",
  "restore",
  "add_tags",
  "remove_tags",
  "add_to_collection",
  "remove_from_collection",
] as const
export const bulkSchema = z
  .object({
    ids: z.array(z.uuid()).min(1).max(200),
    action: z.enum(BULK_ACTIONS),
    tags: z.array(tagName).max(20).optional(),
    collection_id: z.uuid().optional(),
  })
  .superRefine((v, ctx) => {
    if ((v.action === "add_tags" || v.action === "remove_tags") && !v.tags?.length)
      ctx.addIssue({ code: "custom", path: ["tags"], message: "tags required" })
    if ((v.action === "add_to_collection" || v.action === "remove_from_collection") && !v.collection_id)
      ctx.addIssue({ code: "custom", path: ["collection_id"], message: "collection_id required" })
  })

export const uploadRequestSchema = z.object({
  item_id: z.uuid(),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(255),
  size_bytes: z.number().int().min(0),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
})

export const registerFileSchema = z.object({
  file_id: z.uuid(),
  storage_path: z.string().min(1).max(1024),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(255),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
})

export const createShareSchema = z
  .object({
    item_id: z.uuid().optional(),
    collection_id: z.uuid().optional(),
    expires_in_days: z.number().int().min(1).max(365).optional(),
    allow_download: z.boolean().default(true),
  })
  .refine((v) => Boolean(v.item_id) !== Boolean(v.collection_id), "Give exactly one of item_id or collection_id")

export const changesSchema = z.object({
  since: z.string().max(400).optional(),
  /** `now`: return no items, only a token positioned at the present (for clients that page the feed themselves). */
  start: z.enum(["now"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
})

export const profileSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    time_zone: z.string().max(64).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update")
