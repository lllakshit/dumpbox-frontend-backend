import { describe, expect, it } from "vitest"
import { decodeEntities, isBlockedAddress, isFetchableUrl, parsePreview } from "@/lib/link-preview"

describe("link preview safety", () => {
  it.each(["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"])(
    "blocks %s",
    (ip) => expect(isBlockedAddress(ip)).toBe(true),
  )
  it.each(["8.8.8.8", "142.250.183.14", "2606:4700:4700::1111"])("allows public %s", (ip) => expect(isBlockedAddress(ip)).toBe(false))
  it("treats non-IP input as blocked", () => expect(isBlockedAddress("example.com")).toBe(true))

  it.each([
    "file:///etc/passwd",
    "ftp://example.com",
    "http://localhost/admin",
    "http://127.0.0.1/",
    "http://[::1]/",
    "http://169.254.169.254/latest/meta-data",
    "http://user:pass@example.com/",
    "http://example.com:8080/",
    "http://printer.local/",
    "javascript:alert(1)",
  ])("refuses %s", (u) => expect(isFetchableUrl(u)).toBeNull())
  it("accepts a normal https url", () => expect(isFetchableUrl("https://example.com/a?b=1")?.hostname).toBe("example.com"))
})

describe("parsePreview", () => {
  const page = new URL("https://news.example.com/story/1")
  it("reads Open Graph tags and resolves relative images", () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Big &amp; Bold">
      <meta name="description" content="Plain description">
      <meta property="og:image" content="/img/cover.png">
      <meta property="og:site_name" content="Example News"></head><body></body></html>`
    expect(parsePreview(html, page)).toEqual({
      title: "Big & Bold",
      description: "Plain description",
      image_url: "https://news.example.com/img/cover.png",
      site: "Example News",
    })
  })
  it("falls back to <title> and the hostname", () => {
    const p = parsePreview("<head><title> Hello   world </title></head>", new URL("https://www.site.org/"))
    expect(p.title).toBe("Hello world")
    expect(p.site).toBe("site.org")
    expect(p.image_url).toBeNull()
  })
  it("drops non-http image urls", () => {
    const p = parsePreview(`<meta property="og:image" content="javascript:alert(1)">`, page)
    expect(p.image_url).toBeNull()
  })
  it("decodes numeric entities safely", () => {
    expect(decodeEntities("&#x27;a&#39; &#0; &bogus;")).toBe("'a'  &bogus;")
  })
})
