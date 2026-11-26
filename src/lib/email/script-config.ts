/**
 * Fills the Gmail script's CONFIG (labels, priority labels, size limits, key, site address) so "Copy script" gives
 * a script that is ready to run without editing. Pure: unit tested against public/dumpbox-gmail.gs.
 */

export type ScriptConfig = {
  /** Gmail labels to bring in (a parent brings its sub-labels). */
  syncLabels: string[]
  /** Gmail labels for High, Medium, Low ("" = not used). These conversations are brought in too. */
  priority: [string, string, string]
  /** false: a conversation shows only the labels above, not every Gmail label it has. */
  sendAllLabels: boolean
  maxMessages: number
  maxCharsPerMessage: number
}

/**
 * Lakshit's Gmail setup (26 Nov 2026): what he acts on, about 4,700 conversations. Left out on purpose: Job Alerts,
 * the "1 Jobs & Opportunities" parent itself (8,858), "P3 Low Priority" (12,650), newsletters and the zz labels.
 */
export const DEFAULT_SCRIPT_CONFIG: ScriptConfig = {
  syncLabels: [
    "2 Interviews & Follow-ups",
    "1 Jobs & Opportunities/Application Confirmation",
    "1 Jobs & Opportunities/Application Status Update",
    "1 Jobs & Opportunities/Recruiter Outreach",
    "1 Jobs & Opportunities/Rejection",
    "6 Freelance",
    "7 Accounts & Security",
  ],
  priority: ["P0 Act Today", "P1 Within 48h", "P2 This Week"],
  sendAllLabels: false,
  maxMessages: 20,
  maxCharsPerMessage: 20000,
}

/** A JavaScript single-quoted string literal. */
function js(s: string) {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " ")}'`
}

export function cleanLabels(text: string): string[] {
  const seen = new Set<string>()
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      const k = l.toLowerCase()
      if (!l || seen.has(k)) return false
      seen.add(k)
      return true
    })
}

/** Replaces one known piece of the script; throws when it is not there, so a changed script never copies half-filled. */
function swap(text: string, pattern: RegExp, value: string, what: string) {
  if (!pattern.test(text)) throw new Error(`The Gmail script has changed (${what} not found). Reload the page and try again.`)
  return text.replace(pattern, value)
}

export function fillScript(script: string, key: string, apiUrl: string, cfg: ScriptConfig) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("Make an import key first.")
  const labels = cfg.syncLabels.map((l) => `    ${js(l)},`).join("\n")
  const names = ["High", "Medium", "Low"]
  const priority = cfg.priority
    .map((l, i) => ({ l: l.trim(), i }))
    .filter((p) => p.l)
    .map((p) => `    { label: ${js(p.l)}, priority: ${p.i + 1} }, // ${names[p.i]}`)
    .join("\n")
  let out = script
  out = swap(out, /IMPORT_KEY: '[^']*',/, `IMPORT_KEY: '${key}',`, "IMPORT_KEY")
  out = swap(out, /API: '[^']*',/, `API: ${js(apiUrl.replace(/\/$/, ""))},`, "API")
  out = swap(out, /SYNC_LABELS: \[[^\]]*\],/, `SYNC_LABELS: [\n${labels}\n  ],`, "SYNC_LABELS")
  out = swap(out, /PRIORITY: \[[\s\S]*?\n {2}\],/, `PRIORITY: [\n${priority}\n  ],`, "PRIORITY")
  out = swap(out, /SEND_ALL_LABELS: (true|false),/, `SEND_ALL_LABELS: ${cfg.sendAllLabels},`, "SEND_ALL_LABELS")
  out = swap(out, /MAX_MESSAGES: \d+,/, `MAX_MESSAGES: ${Math.max(1, Math.min(50, Math.round(cfg.maxMessages)))},`, "MAX_MESSAGES")
  out = swap(out, /MAX_CHARS_PER_MESSAGE: \d+,/, `MAX_CHARS_PER_MESSAGE: ${Math.max(1000, Math.min(60000, Math.round(cfg.maxCharsPerMessage)))},`, "MAX_CHARS_PER_MESSAGE")
  return out
}
