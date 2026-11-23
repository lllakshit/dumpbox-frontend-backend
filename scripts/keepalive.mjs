#!/usr/bin/env node
/**
 * Keeps the Supabase project awake with a heartbeat write (public key only). If a Supabase access token is also
 * provided, it additionally wakes a paused project; without one, that part is skipped.
 *
 * 1. If SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are set: reads the project status from the Management API.
 *    If the project is paused, asks Supabase to restore it and waits (up to 10 minutes) until it is healthy.
 * 2. Calls the keepalive() database function through the REST API (a real write, so it counts as activity).
 * 3. If APP_URL is set, checks the deployed app answers /v1/health.
 *
 * Env: SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (required); SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, APP_URL,
 * KEEPALIVE_SOURCE (optional). Exits non-zero on failure, so a failed scheduled run is visible (and emailed by GitHub).
 */
import { appendFileSync } from "node:fs"

const env = process.env
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let tokenProblem = null
const lines = []
const log = (msg) => {
  console.log(msg)
  lines.push(`- ${msg}`)
}
const summary = () => {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Supabase keepalive\n${lines.join("\n")}\n`)
}

async function fetchJson(url, init = {}, timeoutMs = 20_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, ok: res.ok, body }
}

async function projectStatus() {
  const r = await fetchJson(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}`, {
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
  })
  if (!r.ok) throw new Error(`Management API answered ${r.status}`)
  return r.body.status
}

async function ensureActive() {
  if (!env.SUPABASE_ACCESS_TOKEN || !env.SUPABASE_PROJECT_REF) {
    log("Status check skipped (no SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF)")
    return
  }
  let status
  try {
    status = await projectStatus()
  } catch (e) {
    // The status check is only needed to wake a paused project. Do not let a bad or expired access token stop the
    // heartbeat itself: warn loudly, then try the write below (which fails the run if the project really is paused).
    tokenProblem = e instanceof Error ? e.message : String(e)
    log(`WARNING: could not read project status (${tokenProblem}). Update the SUPABASE_ACCESS_TOKEN secret.`)
    console.log(`::warning title=Supabase access token::${tokenProblem}. Update the SUPABASE_ACCESS_TOKEN secret; paused projects cannot be woken until then.`)
    return
  }
  log(`Project status: ${status}`)
  if (status === "ACTIVE_HEALTHY") return

  if (["INACTIVE", "PAUSED", "PAUSING"].includes(status)) {
    const r = await fetchJson(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    })
    log(`Project was paused; restore requested (HTTP ${r.status})`)
    if (!r.ok && r.status !== 409) throw new Error(`Restore failed: HTTP ${r.status} ${JSON.stringify(r.body)}`)
  }

  const deadline = Date.now() + 10 * 60_000
  while (Date.now() < deadline) {
    await sleep(20_000)
    status = await projectStatus()
    if (status === "ACTIVE_HEALTHY") {
      log("Project is healthy again")
      return
    }
  }
  throw new Error(`Project did not become healthy in 10 minutes (last status ${status})`)
}

async function ping() {
  const url = env.SUPABASE_URL?.replace(/\/$/, "")
  const key = env.SUPABASE_PUBLISHABLE_KEY
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required")
  let last
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetchJson(`${url}/rest/v1/rpc/keepalive`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ p_source: env.KEEPALIVE_SOURCE ?? "github-actions" }),
    })
    if (r.ok) {
      log(`Database write OK at ${r.body}`)
      return
    }
    last = `HTTP ${r.status} ${JSON.stringify(r.body)}`
    await sleep(attempt * 15_000)
  }
  throw new Error(`Keepalive write failed: ${last}`)
}

async function appHealth() {
  if (!env.APP_URL) return
  const r = await fetchJson(`${env.APP_URL.replace(/\/$/, "")}/v1/health`)
  log(`App health: HTTP ${r.status}`)
  if (!r.ok) throw new Error(`App health check failed: HTTP ${r.status}`)
}

try {
  await ensureActive()
  await ping()
  await appHealth()
  summary()
  // The heartbeat worked, but a bad access token still needs fixing: end with an error so GitHub emails about it.
  if (tokenProblem) {
    console.error(`Heartbeat OK, but the access token is not working (${tokenProblem}).`)
    process.exit(2)
  }
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.message : e}`)
  summary()
  process.exit(1)
}
