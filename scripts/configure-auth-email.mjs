#!/usr/bin/env node
/**
 * Points Supabase Auth email at our SMTP account and installs the DumpBox sign-in email (6-digit code + a link to
 * /auth/confirm that never touches supabase.co). Run by the "Configure sign-in email" workflow, so the SMTP password
 * goes from a GitHub secret straight to Supabase and is never printed.
 *
 * Env: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SMTP_PASSWORD, SMTP_USER (also the From address),
 *      SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 465), SMTP_SENDER_NAME (default DumpBox),
 *      EMAILS_PER_HOUR (default 100).
 */
import { appendFileSync, readFileSync } from "node:fs"

const env = process.env
for (const k of ["SUPABASE_ACCESS_TOKEN", "SUPABASE_PROJECT_REF", "SMTP_PASSWORD", "SMTP_USER"]) {
  if (!env[k]) {
    console.error(`Missing ${k}`)
    process.exit(1)
  }
}

const template = readFileSync(new URL("../supabase/templates/otp.html", import.meta.url), "utf8")
const body = {
  smtp_host: env.SMTP_HOST || "smtp.gmail.com",
  smtp_port: String(env.SMTP_PORT || "465"),
  smtp_user: env.SMTP_USER.trim(),
  // Gmail shows app passwords in groups of four; the spaces are not part of it.
  smtp_pass: env.SMTP_PASSWORD.replace(/\s+/g, ""),
  smtp_admin_email: env.SMTP_USER.trim(),
  smtp_sender_name: env.SMTP_SENDER_NAME || "DumpBox",
  smtp_max_frequency: 30,
  rate_limit_email_sent: Number(env.EMAILS_PER_HOUR || 100),
  mailer_otp_length: 6,
  mailer_otp_exp: 600,
  mailer_subjects_magic_link: "Your DumpBox sign-in code",
  mailer_subjects_confirmation: "Your DumpBox sign-in code",
  mailer_templates_magic_link_content: template,
  mailer_templates_confirmation_content: template,
}

const res = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/config/auth`, {
  method: "PATCH",
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify(body),
})
const out = await res.json().catch(() => ({}))
if (!res.ok) {
  console.error(`Supabase refused the settings: HTTP ${res.status} ${out.message ?? ""}`)
  process.exit(1)
}

const checks = {
  "SMTP host": out.smtp_host,
  "SMTP port": out.smtp_port,
  "From": `${out.smtp_sender_name} <${out.smtp_admin_email}>`,
  "Code length": out.mailer_otp_length,
  "Code expiry (s)": out.mailer_otp_exp,
  "Emails per hour": out.rate_limit_email_sent,
  "Template shows the code": String(out.mailer_templates_magic_link_content ?? "").includes("{{ .Token }}"),
  "Template link uses /auth/confirm": String(out.mailer_templates_magic_link_content ?? "").includes("/auth/confirm"),
}
const lines = Object.entries(checks).map(([k, v]) => `- ${k}: ${v}`)
console.log(lines.join("\n"))
if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Sign-in email configured\n${lines.join("\n")}\n`)
if (!checks["Template shows the code"] || out.smtp_host !== body.smtp_host) process.exit(1)
