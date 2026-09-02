import { ReactNode } from 'react'

interface PageHeaderProps {
  /** The `~/path` line that names where you are. */
  path: string
  title: string
  subtitle?: ReactNode
  /** The one thing this page wants you to do next. */
  action?: ReactNode
  children?: ReactNode
}

/**
 * Page title on the left, the page's single primary action on the right.
 *
 * One action, not a row of them: a header that offers three equal buttons has
 * already failed to say which one the page is for.
 */
export function PageHeader({ path, title, subtitle, action, children }: PageHeaderProps) {
  return (
    <header className="mb-8 flex items-end justify-between flex-wrap gap-4">
      <div>
        <div className="font-mono text-caption text-brand">{path}</div>
        <h1 className="font-display text-head-lg text-ink mt-1">{title}</h1>
        {subtitle && (
          <p className="font-mono text-caption text-ink-2 mt-1.5 max-w-lg">{subtitle}</p>
        )}
      </div>
      {action}
      {children}
    </header>
  )
}
