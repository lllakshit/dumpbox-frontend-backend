import { unstable_rethrow } from "next/navigation"
import { ZodError } from "zod"

/** Machine-readable error codes returned in `{ error: { code, message } }`. */
export type ErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "conflict"
  | "payload_too_large"
  | "unsupported_file_type"
  | "gone"
  | "rate_limited"
  | "internal_error"

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  conflict: 409,
  payload_too_large: 413,
  unsupported_file_type: 415,
  gone: 410,
  rate_limited: 429,
  internal_error: 500,
}

export class ApiError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message)
  }
}

const NO_STORE = { "Cache-Control": "no-store" }

export function ok(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, { status, headers: { ...NO_STORE, ...headers } })
}

export function noContent() {
  return new Response(null, { status: 204, headers: NO_STORE })
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return Response.json(
      { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
      { status: STATUS[err.code], headers: NO_STORE },
    )
  }
  if (err instanceof ZodError) {
    return Response.json(
      {
        error: {
          code: "validation_failed",
          message: "Request is not valid",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        },
      },
      { status: 400, headers: NO_STORE },
    )
  }
  console.error("[api] unhandled error", err)
  return Response.json({ error: { code: "internal_error", message: "Something went wrong" } }, { status: 500, headers: NO_STORE })
}

/** Wraps a handler so every thrown error becomes the standard JSON error response. */
export function handler<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args)
    } catch (err) {
      // Next.js signals (prerender bail-out, redirects) must pass through untouched.
      unstable_rethrow(err)
      return errorResponse(err)
    }
  }
}

type PgError = { code?: string; message?: string; details?: string | null; hint?: string | null }

/** Turns a Supabase/PostgREST error into an ApiError with the right status. */
export function fromDb(error: PgError, notFoundMessage = "Not found"): ApiError {
  switch (error.code) {
    case "PGRST116":
      return new ApiError("not_found", notFoundMessage)
    case "42501":
      return new ApiError("not_found", notFoundMessage)
    case "23505":
      return new ApiError("conflict", "Already exists")
    case "23503":
      return new ApiError("not_found", notFoundMessage)
    case "23514":
    case "22023":
    case "22P02":
    case "22001":
    case "22003":
      return new ApiError("validation_failed", error.message ?? "Invalid value")
    default:
      console.error("[api] database error", error)
      return new ApiError("internal_error", "Database request failed")
  }
}

/** Reads and parses a JSON body, with a size cap (bytes, not characters). */
export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<unknown> {
  const len = Number(request.headers.get("content-length") ?? "0")
  if (len > maxBytes) throw new ApiError("payload_too_large", `Body must be at most ${maxBytes} bytes`)
  const buf = await request.arrayBuffer()
  if (buf.byteLength > maxBytes) throw new ApiError("payload_too_large", `Body must be at most ${maxBytes} bytes`)
  if (buf.byteLength === 0) return {}
  try {
    return JSON.parse(new TextDecoder().decode(buf))
  } catch {
    throw new ApiError("validation_failed", "Body must be valid JSON")
  }
}

export function searchParams(request: Request) {
  return new URL(request.url).searchParams
}
