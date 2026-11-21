import "server-only"
import { lookup as dnsLookup } from "node:dns"
import { BlockList, isIP } from "node:net"
import { Agent, fetch as undiciFetch } from "undici"

export type LinkPreview = { title: string | null; description: string | null; image_url: string | null; site: string | null }

/** Addresses a preview fetch must never reach (private, loopback, link-local, metadata, multicast...). */
const blocked = new BlockList()
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  blocked.addSubnet(net, prefix, "ipv4")
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(net, prefix, "ipv6")

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return blocked.check(address, "ipv4")
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
    if (mapped) return blocked.check(mapped[1], "ipv4")
    return blocked.check(address, "ipv6")
  }
  return true
}

/**
 * DNS lookup used for every connection the preview agent opens. Checking here (not before fetch) closes the
 * DNS-rebinding gap: the address we vet is the address we connect to.
 */
function safeLookup(
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, [])
    const list = addresses as { address: string; family: number }[]
    if (!list.length || list.some((a) => isBlockedAddress(a.address))) {
      const e: NodeJS.ErrnoException = new Error(`Blocked address for ${hostname}`)
      e.code = "EBLOCKED"
      return callback(e, [])
    }
    if ((options as { all?: boolean }).all) return callback(null, list)
    callback(null, list[0].address, list[0].family)
  })
}

const agent = new Agent({ connect: { lookup: safeLookup, timeout: 3000 }, headersTimeout: 3000, bodyTimeout: 3000 })

const MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3

export function isFetchableUrl(raw: string): URL | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null
  if (u.username || u.password) return null
  if (u.port && u.port !== "80" && u.port !== "443") return null
  const host = u.hostname.replace(/^\[|\]$/g, "")
  if (isIP(host) && isBlockedAddress(host)) return null
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) return null
  return u
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}
function safeChar(code: number) {
  return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ""
}

function clean(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  const v = decodeEntities(s).replace(/\s+/g, " ").trim()
  return v ? v.slice(0, max) : null
}

/** Pulls title, description, image and site name out of an HTML head. */
export function parsePreview(html: string, pageUrl: URL): LinkPreview {
  const head = html.slice(0, 200_000)
  const metas = new Map<string, string>()
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)
    const key = attr("property") ?? attr("name")
    const content = attr("content")
    if (!key || !content) continue
    const k = (key[2] ?? key[3] ?? key[4] ?? "").toLowerCase()
    if (k && !metas.has(k)) metas.set(k, content[2] ?? content[3] ?? content[4] ?? "")
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  let image = metas.get("og:image") ?? metas.get("og:image:url") ?? metas.get("twitter:image") ?? null
  if (image) {
    try {
      const abs = new URL(decodeEntities(image), pageUrl)
      image = abs.protocol === "https:" || abs.protocol === "http:" ? abs.toString().slice(0, 4000) : null
    } catch {
      image = null
    }
  }
  return {
    title: clean(metas.get("og:title") ?? metas.get("twitter:title") ?? titleTag, 1000),
    description: clean(metas.get("og:description") ?? metas.get("description") ?? metas.get("twitter:description"), 4000),
    image_url: image,
    site: clean(metas.get("og:site_name"), 300) ?? pageUrl.hostname.replace(/^www\./, ""),
  }
}

/**
 * Fetches a page safely and returns its preview, or null on any failure. Capture never waits on this for long
 * and never fails because of it.
 */
export async function fetchLinkPreview(raw: string, timeoutMs = 4000): Promise<LinkPreview | null> {
  let url = isFetchableUrl(raw)
  if (!url) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await undiciFetch(url, {
        dispatcher: agent,
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "DumpBoxPreview/1.0 (+link preview)",
          accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        },
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location")
        await res.body?.cancel()
        if (!loc) return null
        const next = isFetchableUrl(new URL(loc, url).toString())
        if (!next) return null
        url = next
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        return { title: null, description: null, image_url: null, site: url.hostname.replace(/^www\./, "") }
      }
      const type = res.headers.get("content-type") ?? ""
      if (!/text\/html|application\/xhtml/i.test(type)) {
        await res.body?.cancel()
        return { title: null, description: null, image_url: null, site: url.hostname.replace(/^www\./, "") }
      }
      const reader = res.body?.getReader()
      if (!reader) return null
      const chunks: Uint8Array[] = []
      let size = 0
      while (size < MAX_BYTES) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        size += value.byteLength
        // The head is all we need.
        if (/<\/head>/i.test(new TextDecoder().decode(value))) break
      }
      await reader.cancel().catch(() => {})
      const html = new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks).subarray(0, MAX_BYTES))
      return parsePreview(html, url)
    }
    return null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
