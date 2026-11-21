import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DumpBox",
    short_name: "DumpBox",
    description: "Dump anything in one tap. Find it in one search.",
    start_url: "/",
    display: "standalone",
    background_color: "#f5f3ef",
    theme_color: "#3a5bd9",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  }
}
