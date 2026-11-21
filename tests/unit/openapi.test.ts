import { readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import { openapi } from "@/lib/openapi"

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return routeFiles(p)
    return name === "route.ts" ? [p] : []
  })
}

describe("openapi document", () => {
  const root = join(process.cwd(), "src/app")
  const paths = routeFiles(join(root, "v1")).map((f) =>
    "/" + relative(root, f).replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}"),
  )
  it("documents every /v1 route", () => {
    const documented = Object.keys(openapi.paths)
    expect(paths.filter((p) => !documented.includes(p))).toEqual([])
    expect(documented.filter((p) => !paths.includes(p))).toEqual([])
  })
})
