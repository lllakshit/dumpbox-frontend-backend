import { createHash, randomBytes } from "node:crypto"

/** 32 random bytes, URL-safe. Only its SHA-256 is stored, so a database leak does not leak working links. */
export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url")
  return { token, hash: hashShareToken(token) }
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex")
}

export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
