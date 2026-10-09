import { notFound, permanentRedirect } from 'next/navigation'
import { PUBLISHED_DOCS } from '@/lib/published-docs'

// The reference documents are sections of /docs now. The old addresses stay
// valid and land on the same text.
export default async function DocRedirect({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params
  if (!PUBLISHED_DOCS[doc]) notFound()
  permanentRedirect(`/docs#${doc}`)
}
