import { permanentRedirect } from 'next/navigation'

// Rendered per request so the redirect is a real Location header; a
// prerendered redirect answers 308 with nowhere to go.
export const dynamic = 'force-dynamic'

// The adversarial program is a section of /docs, rendered from
// docs/ADVERSARIAL.md. This page used to restate that file by hand and had
// already fallen behind it; the address stays valid and lands on the file.
export default function SecurityRedirect() {
  permanentRedirect('/docs#adversarial')
}
