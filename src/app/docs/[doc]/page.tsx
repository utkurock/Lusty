import { notFound, permanentRedirect } from 'next/navigation'
import { PUBLISHED_DOCS } from '@/lib/published-docs'

// The reference documents are sections of /docs now. The old addresses stay
// valid and land on the same text.
export default function DocRedirect({ params }: { params: { doc: string } }) {
  if (!PUBLISHED_DOCS[params.doc]) notFound()
  permanentRedirect(`/docs#${params.doc}`)
}
