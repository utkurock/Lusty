import { permanentRedirect } from 'next/navigation'

// Rendered per request so the redirect is a real Location header; a
// prerendered redirect answers 308 with nowhere to go.
export const dynamic = 'force-dynamic'

// The architecture is a section of /docs now; this address stays valid.
export default function ArchitectureRedirect() {
  permanentRedirect('/docs#architecture')
}
