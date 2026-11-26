import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { cleanLabels, DEFAULT_SCRIPT_CONFIG, fillScript } from "@/lib/email/script-config"

const script = readFileSync(join(process.cwd(), "public/dumpbox-gmail.gs"), "utf8")
const KEY = "A".repeat(43)

/** Runs the filled script's CONFIG block as JavaScript and returns it. */
function configOf(filled: string) {
  const start = filled.indexOf("const CONFIG = {")
  const end = filled.indexOf("\n};", start) + 3
  return new Function(`${filled.slice(start, end)}; return CONFIG;`)() as Record<string, unknown>
}

describe("Copy script", () => {
  it("fills key, site, labels, priority and limits into the real script", () => {
    const filled = fillScript(script, KEY, "https://dumpbox-app.vercel.app/", DEFAULT_SCRIPT_CONFIG)
    const c = configOf(filled)
    expect(c.IMPORT_KEY).toBe(KEY)
    expect(c.API).toBe("https://dumpbox-app.vercel.app")
    expect(c.SYNC_LABELS).toEqual(DEFAULT_SCRIPT_CONFIG.syncLabels)
    expect(c.PRIORITY).toEqual([
      { label: "P0 Act Today", priority: 1 },
      { label: "P1 Within 48h", priority: 2 },
      { label: "P2 This Week", priority: 3 },
    ])
    expect(c.SEND_ALL_LABELS).toBe(false)
    expect(c.MAX_MESSAGES).toBe(20)
    expect(c.MAX_CHARS_PER_MESSAGE).toBe(20000)
    // The rest of the script is untouched.
    expect(filled.slice(filled.indexOf("const REQUEST_BYTES"))).toBe(script.slice(script.indexOf("const REQUEST_BYTES")))
  })

  it("keeps quotes and & in label names safe, and drops unused priority slots", () => {
    const c = configOf(fillScript(script, KEY, "https://x.test", { ...DEFAULT_SCRIPT_CONFIG, syncLabels: ["Tom's & Co", "a\\b"], priority: ["Urgent", "", ""] }))
    expect(c.SYNC_LABELS).toEqual(["Tom's & Co", "a\\b"])
    expect(c.PRIORITY).toEqual([{ label: "Urgent", priority: 1 }])
  })

  it("needs a key, and cleans the typed label list", () => {
    expect(() => fillScript(script, "", "https://x.test", DEFAULT_SCRIPT_CONFIG)).toThrow()
    expect(cleanLabels(" Bills \n\nbills\nTravel ")).toEqual(["Bills", "Travel"])
  })
})
