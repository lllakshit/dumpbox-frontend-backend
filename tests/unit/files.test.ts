import { describe, expect, it } from "vitest"
import { extensionOf, isBlockedFile, itemTypeForMime, safeObjectName, storagePath } from "@/lib/api/files"

describe("upload rules", () => {
  it.each([
    ["setup.exe", "application/octet-stream"],
    ["run.sh", "text/plain"],
    ["page.html", "text/html"],
    ["logo.svg", "image/svg+xml"],
    ["app.apk", "application/vnd.android.package-archive"],
    ["notes.txt", "text/html"],
  ])("blocks %s (%s)", (name, mime) => expect(isBlockedFile(name, mime)).toBe(true))
  it.each([
    ["invoice.pdf", "application/pdf"],
    ["photo.JPG", "image/jpeg"],
    ["sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["archive.zip", "application/zip"],
    ["voice.m4a", "audio/mp4"],
  ])("allows %s", (name, mime) => expect(isBlockedFile(name, mime)).toBe(false))

  it("builds safe ascii storage keys", () => {
    expect(safeObjectName("Électricité bill (Oct).PDF")).toBe("Electricite-bill-Oct.pdf")
    expect(safeObjectName("../../etc/passwd")).toBe("passwd")
    expect(safeObjectName("....")).toBe("file")
    expect(storagePath("u", "i", "f", "a b.png")).toBe("u/i/f-a-b.png")
  })
  it("reads extensions", () => {
    expect(extensionOf("a.tar.gz")).toBe("gz")
    expect(extensionOf("noext")).toBe("")
  })
  it("maps mime to item type", () => {
    expect(itemTypeForMime("image/png")).toBe("image")
    expect(itemTypeForMime("audio/mpeg")).toBe("voice")
    expect(itemTypeForMime("application/pdf")).toBe("file")
  })
})
