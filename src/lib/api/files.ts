/** Upload rules shared by the API and the clients' pre-checks. */

export const BUCKET = "items"
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** Executables and scripts are never accepted (FR-40). Checked by extension and by MIME type. */
const BLOCKED_EXTENSIONS = new Set([
  "exe", "dll", "com", "bat", "cmd", "msi", "msp", "scr", "pif", "cpl", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "ps1", "psm1", "sh", "bash", "zsh", "app", "dmg", "pkg", "jar", "apk", "aab", "ipa", "deb", "rpm", "reg", "lnk",
  "hta", "html", "htm", "xhtml", "svg", "mht", "mhtml",
])
const BLOCKED_MIME = [
  /^application\/(x-)?(msdownload|msdos-program|ms-installer|x-msi|executable|x-sh|x-shellscript|java-archive|vnd\.android\.package-archive)$/i,
  /^text\/(html|javascript)$/i,
  /^application\/(javascript|ecmascript|xhtml\+xml)$/i,
  /^image\/svg\+xml$/i,
]

export function extensionOf(name: string): string {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name.trim())
  return m ? m[1].toLowerCase() : ""
}

export function isBlockedFile(name: string, mime: string): boolean {
  return BLOCKED_EXTENSIONS.has(extensionOf(name)) || BLOCKED_MIME.some((re) => re.test(mime))
}

/** Keeps storage keys ASCII and predictable; the original name is kept in the files table. */
export function safeObjectName(raw: string): string {
  const name = raw.split(/[\\/]/).pop() ?? ""
  const ext = extensionOf(name)
  const base = name
    .replace(/\.[^.]*$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return `${base || "file"}${ext ? `.${ext}` : ""}`
}

export function storagePath(userId: string, itemId: string, fileId: string, name: string) {
  return `${userId}/${itemId}/${fileId}-${safeObjectName(name)}`
}

export function itemTypeForMime(mime: string): "image" | "voice" | "file" {
  if (/^image\//i.test(mime)) return "image"
  if (/^audio\//i.test(mime)) return "voice"
  return "file"
}
