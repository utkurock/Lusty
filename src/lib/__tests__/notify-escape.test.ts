import { describe, it, expect, vi, afterEach } from 'vitest'

// A security report's summary reaches the maintainers' Slack verbatim. Slack
// reads <!channel> as a page and <url|label> as a link that hides its target.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('alerts posted to Slack', () => {
  it('cannot ping the channel or disguise a link', async () => {
    vi.stubEnv('MONITOR_SLACK_WEBHOOK_URL', 'https://hooks.example/test')
    const fetch = vi.fn(async (..._a: any[]) => new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    const { sendAlert } = await import('../monitor/notify')

    await sendAlert({
      severity: 'critical',
      title: 'LSR-001',
      message: '<!channel> <https://evil.example/admin|Open triage in admin panel> & more',
      fields: [{ label: 'contact', value: '<@U123>' }],
    })

    const slack = fetch.mock.calls.find((c) => String(c[0]).includes('hooks.example'))!
    const text: string = JSON.parse((slack[1] as RequestInit).body as string).text
    expect(text).not.toMatch(/<[!@h]/)
    expect(text).toContain('&lt;!channel&gt;')
    expect(text).toContain('&amp; more')
  })
})
