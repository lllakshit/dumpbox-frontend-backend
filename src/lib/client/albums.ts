import type { Item } from "./types"

/** Photos added within this gap of each other show as one album, like WhatsApp (same rule as the phone app). */
export const ALBUM_GAP_MS = 2 * 60_000

/** A photo item that can join an album: exactly one image file and no title. */
export function isAlbumPhoto(i: Item): boolean {
  return i.type === "image" && i.files.length === 1 && i.files[0].mime_type.startsWith("image/") && !i.title
}

const hasCaption = (i: Item) => Boolean(i.body && i.body.trim())
const tagKey = (i: Item) => i.tags.map((t) => t.name).sort().join("|")
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString()

/**
 * Groups a newest-first list into rows: a single item, or an album of 2+ photos (also newest first).
 * Photos join when added within ALBUM_GAP_MS of the next one, on the same day, with the same tags.
 * Only the first photo of a batch carries the caption (the composer puts it there), so a captioned photo
 * closes its album. `canGroup` lets the caller keep some items out (e.g. ones still uploading).
 */
export function groupIntoAlbums<T>(rows: T[], itemOf: (r: T) => Item, canGroup: (r: T) => boolean = () => true): T[][] {
  const out: T[][] = []
  let i = 0
  while (i < rows.length) {
    const first = rows[i]
    const group = [first]
    const f = itemOf(first)
    if (canGroup(first) && isAlbumPhoto(f) && !hasCaption(f)) {
      for (let j = i + 1; j < rows.length; j++) {
        const newer = itemOf(rows[j - 1])
        const older = itemOf(rows[j])
        if (!canGroup(rows[j]) || !isAlbumPhoto(older)) break
        const gap = Math.abs(Date.parse(newer.created_at) - Date.parse(older.created_at))
        if (gap > ALBUM_GAP_MS || !sameDay(newer.created_at, older.created_at) || tagKey(newer) !== tagKey(older)) break
        group.push(rows[j])
        if (hasCaption(older)) break
      }
    }
    out.push(group)
    i += group.length
  }
  return out
}
