import { describe, expect, it, vi } from "vitest"

describe("viaProxy", () => {
  it("moves Supabase URLs onto the app's /sb path and leaves others alone", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abc.supabase.co")
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://dumpbox-app.vercel.app")
    vi.resetModules()
    const { viaProxy } = await import("@/lib/env")
    expect(viaProxy("https://abc.supabase.co/storage/v1/object/sign/items/u/i/f-a.pdf?token=t")).toBe(
      "https://dumpbox-app.vercel.app/sb/storage/v1/object/sign/items/u/i/f-a.pdf?token=t",
    )
    expect(viaProxy("https://example.com/x")).toBe("https://example.com/x")
    expect(viaProxy("https://abc.supabase.co.evil.com/x")).toBe("https://abc.supabase.co.evil.com/x")
    expect(viaProxy(null)).toBeNull()
    vi.unstubAllEnvs()
  })
})
