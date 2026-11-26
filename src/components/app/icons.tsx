/** Small line icons (24px grid, currentColor). */
import type { ReactNode, SVGProps } from "react"

function I({ children, ...p }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
      {children}
    </svg>
  )
}

export const Icon = {
  feed: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 6h16M4 12h16M4 18h10" /></I>,
  search: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>,
  pin: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M9 4h6l-1 6 3 3H7l3-3zM12 13v7" /></I>,
  star: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" /></I>,
  archive: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10h14V9M10 13h4" /></I>,
  trash: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></I>,
  note: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M6 3h9l4 4v14H6z" /><path d="M9 11h7M9 15h7" /></I>,
  link: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></I>,
  image: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></I>,
  file: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M14 3H6v18h12V7z" /><path d="M14 3v4h4" /></I>,
  place: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M12 21s7-6 7-12a7 7 0 1 0-14 0c0 6 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></I>,
  voice: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></I>,
  tag: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="7.5" r="1.5" /></I>,
  folder: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M3 6h6l2 2h10v11H3z" /></I>,
  share: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="18" cy="5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="19" r="2.5" /><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4" /></I>,
  settings: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></I>,
  plus: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M12 5v14M5 12h14" /></I>,
  attach: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-2.8-2.8L15 7.5" /></I>,
  send: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 12 20 4l-6 16-3-7z" /></I>,
  more: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></I>,
  close: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>,
  check: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="m5 12 5 5 9-10" /></I>,
  download: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></I>,
  copy: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></I>,
  edit: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 20h4L19 9l-4-4L4 16z" /></I>,
  history: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></I>,
  restore: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 10a8 8 0 1 1 2 7" /><path d="M4 4v6h6" /></I>,
  menu: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M4 7h16M4 12h16M4 17h16" /></I>,
  cloudOff: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M3 3l18 18M8 8a5 5 0 0 0-3 9h11M19.4 15.4A4 4 0 0 0 17 9h-1a6 6 0 0 0-5.3-3.9" /></I>,
  calendar: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /><path d="M8 14h3v3H8z" /></I>,
  task: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></I>,
  upload: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M12 20V9M7 14l5-5 5 5M5 4h14" /></I>,
  bell: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M6 16V11a6 6 0 1 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></I>,
  select: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 3 3 5-6" /></I>,
  mail: (p: SVGProps<SVGSVGElement>) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></I>,
  dot: (p: SVGProps<SVGSVGElement>) => <I {...p}><circle cx="12" cy="12" r="4" /></I>,
  external: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></I>,
  back: (p: SVGProps<SVGSVGElement>) => <I {...p}><path d="M15 5 8 12l7 7" /></I>,
}
