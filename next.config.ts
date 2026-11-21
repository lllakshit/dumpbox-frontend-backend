import type { NextConfig } from "next"

/**
 * Supabase is reached by browsers and phones through this app's own domain: /sb/* is passed through to the Supabase
 * project. Some Indian internet providers block *.supabase.co, so clients never talk to it directly.
 * (Servers on Vercel still call Supabase directly.)
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "")

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async rewrites() {
    return supabaseUrl ? [{ source: "/sb/:path*", destination: `${supabaseUrl}/:path*` }] : []
  },
}

export default nextConfig
