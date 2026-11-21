import { Suspense } from "react"
import type { Metadata } from "next"
import { SharedView } from "@/components/share/SharedView"

export const metadata: Metadata = {
  title: { absolute: "Shared from DumpBox" },
  robots: { index: false, follow: false },
  referrer: "no-referrer",
}

/** Public page for a share link. The shell is static; the token is read and resolved in the browser. */
export default function SharedPage() {
  return (
    <Suspense fallback={<p className="p-8 text-ink-3">Opening…</p>}>
      <SharedView />
    </Suspense>
  )
}
