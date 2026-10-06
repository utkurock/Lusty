// The reference documents the site publishes, and where each one lives.
// ====================================================================
// They are sections of the one documentation page, rendered from the files in
// docs/ so the page and the repository cannot disagree. A slug never becomes a
// path: it is looked up here, which is the whole of what the site will read.

export interface PublishedDoc {
  file: string
  title: string
  blurb: string
}

export const PUBLISHED_DOCS: Record<string, PublishedDoc> = {
  adversarial: {
    file: 'ADVERSARIAL.md',
    title: 'Adversarial testnet program',
    blurb: 'Scope, rules of engagement, severity, and what counts as resolved.',
  },
  reporting: {
    file: 'REPORTING.md',
    title: 'Reporting a finding',
    blurb: 'Where to send one, and the five things it needs.',
  },
  deployments: {
    file: 'DEPLOYMENTS.md',
    title: 'Deployed addresses',
    blurb: 'Every address the deployment runs on, and how to read it back yourself.',
  },
  reproduce: {
    file: 'REPRODUCE.md',
    title: 'Reproducing every flow',
    blurb: 'Runnable, from a clean checkout, against the deployed instances.',
  },
  'multi-asset': {
    file: 'MULTI-ASSET.md',
    title: 'Adding an underlying',
    blurb: 'Every field an asset is declared with, its units, and what happens when it is wrong.',
  },
  'liquidity-routing': {
    file: 'LIQUIDITY-ROUTING.md',
    title: 'Liquidity routing guardrails',
    blurb: 'What a routed swap may do, what stops it, and what happens when each guardrail fires.',
  },
}

const REPO_DOCS = 'https://github.com/utkurock/Lusty/blob/main/docs/'

/**
 * Where a link to `docs/<FILE>.md` should go: its section of the documentation
 * page when the site publishes it, the file on GitHub when it does not.
 */
export function docLinkFor(file: string): string {
  const slug = Object.keys(PUBLISHED_DOCS).find((s) => PUBLISHED_DOCS[s].file === file)
  return slug ? `/docs#${slug}` : `${REPO_DOCS}${file}`
}
