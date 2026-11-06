import React from "react";

const BLUESKY_PATH = "M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z";
const LINKEDIN_PATH = "M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9.75h4V21H3V9.75Zm6.5 0h3.83v1.54h.05c.53-1 1.84-2.05 3.78-2.05 4.04 0 4.79 2.66 4.79 6.12V21h-4v-4.99c0-1.19-.02-2.72-1.66-2.72-1.66 0-1.91 1.3-1.91 2.63V21h-4V9.75Z";

/** A platform's mark, named for screen readers and in a tooltip. */
export function PlatformIcon({ connector, name }: { connector: string; name: string }) {
  const mark = connector === "youtube"
    ? <><rect x="1" y="4" width="22" height="16" rx="4.5" fill="#ff0000" /><path d="M10 8.5v7l6-3.5z" fill="#fff" /></>
    : connector === "bluesky"
      ? <path d={BLUESKY_PATH} fill="#0085ff" />
      : connector === "linkedin"
        ? <path d={LINKEDIN_PATH} fill="#0a66c2" />
        // An article goes to a folder or a site: a page with lines.
        : <><rect x="5" y="2.5" width="14" height="19" rx="1.5" fill="none" stroke="var(--muted-foreground)" strokeWidth="1.8" /><path d="M8.5 8h7M8.5 12h7M8.5 16h4.5" stroke="var(--muted-foreground)" strokeWidth="1.8" strokeLinecap="round" /></>;
  return <svg className="platform-icon" viewBox="0 0 24 24" role="img" aria-label={name}><title>{name}</title>{mark}</svg>;
}
