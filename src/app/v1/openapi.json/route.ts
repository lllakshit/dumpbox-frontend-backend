import { openapi } from "@/lib/openapi"

/** GET /v1/openapi.json — the API description (static, prerendered at build). */
export function GET() {
  return Response.json(openapi)
}
