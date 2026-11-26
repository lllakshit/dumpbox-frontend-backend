import { importThreads, userForImportKey } from "@/lib/api/email"
import { handler, ok, readJson } from "@/lib/api/http"
import { importSchema } from "@/lib/email/normalize"
import { adminClient } from "@/lib/supabase/server"

/**
 * POST /v1/email/import — used by the Gmail script, authenticated with an import key (`Authorization: Bearer <key>`,
 * made in Settings → Email), not a sign-in. Body: `{ threads: [...] }`, up to 50 conversations and 4 MB.
 * Sending a conversation again updates it; conversations deleted in DumpBox are skipped.
 */
export const POST = handler(async (request: Request) => {
  const admin = adminClient()
  const userId = await userForImportKey(admin, request)
  const input = importSchema.parse(await readJson(request, 4 * 1024 * 1024))
  const result = await importThreads(admin, userId, input.threads)
  return ok(result)
})
