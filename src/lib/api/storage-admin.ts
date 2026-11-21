import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { BUCKET } from "./files"

const PAGE = 1000

/** Every object under a user's folder ("<uid>/<item>/<file>"), paged so no cap applies. Uses the server client. */
export async function listUserObjects(admin: SupabaseClient, userId: string): Promise<string[]> {
  const bucket = admin.storage.from(BUCKET)
  const paths: string[] = []
  const folders: string[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await bucket.list(userId, { limit: PAGE, offset })
    if (error) throw error
    for (const e of data ?? []) {
      if (e.id === null) folders.push(`${userId}/${e.name}`)
      else paths.push(`${userId}/${e.name}`)
    }
    if (!data || data.length < PAGE) break
  }
  for (const folder of folders) {
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await bucket.list(folder, { limit: PAGE, offset })
      if (error) throw error
      for (const e of data ?? []) if (e.id !== null) paths.push(`${folder}/${e.name}`)
      if (!data || data.length < PAGE) break
    }
  }
  return paths
}

export async function removeObjects(admin: SupabaseClient, paths: string[]) {
  for (let i = 0; i < paths.length; i += 500) {
    const { error } = await admin.storage.from(BUCKET).remove(paths.slice(i, i + 500))
    if (error) throw error
  }
}

/** Same rule the database enforces: "<owner>/<item>/<file id>-<safe name>". */
export function isValidFilePath(path: string, userId: string, itemId: string, fileId: string) {
  const esc = (s: string) => s.replace(/[^0-9a-f-]/gi, "")
  return new RegExp(`^${esc(userId)}/${esc(itemId)}/${esc(fileId)}-[A-Za-z0-9_-]{1,80}(\\.[a-z0-9]{1,10})?$`).test(path)
}
