import {
  Wordmark,
  Eyebrow,
  Kicker,
  Terminal,
  TerminalLine,
  TerminalToken,
  CLIInstallBlock,
  RoverBadge,
  ProofRow,
  CompareTable,
  AgentStatusLine,
} from '@/components/brand';

function Section({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border py-12">
      <Eyebrow prefix className="mb-6">
        {eyebrow}
      </Eyebrow>
      {children}
    </section>
  );
}

export default function DesignSystemPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-[1100px] px-6 py-16">
        {/* HEADER */}
        <header className="mb-16 flex flex-col gap-6">
          <Kicker status="live">Live · Phase 12 · Wave 2</Kicker>
          <Wordmark size="lg" />
          <p className="max-w-[720px] text-lg text-muted-foreground">
            Mission Control Brutalism. Nine brand primitives, rendered on the void. Read{' '}
            <a className="text-foreground underline decoration-dotted underline-offset-4" href="/">
              DESIGN.md
            </a>{' '}
            at the repo root for the full token system.
          </p>
        </header>

        {/* WORDMARK */}
        <Section eyebrow="Wordmark">
          <div className="flex flex-col items-start gap-8">
            <Wordmark size="sm" />
            <Wordmark size="md" />
            <Wordmark size="lg" />
          </div>
        </Section>

        {/* KICKERS */}
        <Section eyebrow="Kickers">
          <div className="flex flex-wrap gap-3">
            <Kicker status="live">Live · v{__APP_VERSION__}</Kicker>
            <Kicker status="armed">Armed</Kicker>
            <Kicker status="beta">Beta · Preview</Kicker>
            <Kicker status="offline">Offline</Kicker>
            <Kicker>Self-hosted</Kicker>
          </div>
        </Section>

        {/* EYEBROWS */}
        <Section eyebrow="Eyebrows">
          <div className="flex flex-col gap-3">
            <Eyebrow prefix>Features</Eyebrow>
            <Eyebrow prefix>The Fleet</Eyebrow>
            <Eyebrow>Under 60 seconds</Eyebrow>
          </div>
        </Section>

        {/* CLI INSTALL */}
        <Section eyebrow="CLI Install Block">
          <CLIInstallBlock command="npm install -g coderover && rover land" />
        </Section>

        {/* TERMINAL */}
        <Section eyebrow="Terminal">
          <Terminal title="~/my-app — rover">
            <TerminalLine prompt>
              <TerminalToken tone="bone">rover land</TerminalToken> https://github.com/your-org/your-repo
            </TerminalLine>
            <TerminalLine muted>  ↓ authenticating mission control...        <TerminalToken tone="accent">ok</TerminalToken></TerminalLine>
            <TerminalLine muted>  ↓ indexing 1,247 modules (312k LoC)...     <TerminalToken tone="accent">ok</TerminalToken></TerminalLine>
            <TerminalLine muted>  ↓ building dependency graph...             <TerminalToken tone="accent">ok</TerminalToken></TerminalLine>
            <TerminalLine><TerminalToken tone="accent">  ✓ fleet landed in 47s</TerminalToken></TerminalLine>
            <TerminalLine> </TerminalLine>
            <TerminalLine prompt>
              <TerminalToken tone="bone">rover status</TerminalToken>
            </TerminalLine>
            <TerminalLine muted>  [scout]    online  · watching 4 open PRs</TerminalLine>
            <TerminalLine muted>  [sentinel] online  · <TerminalToken tone="warning">2 findings</TerminalToken> (low severity)</TerminalLine>
          </Terminal>
        </Section>

        {/* AGENT STATUS LINES */}
        <Section eyebrow="Agent Status Lines">
          <div className="flex flex-col gap-2 border border-border bg-card p-4">
            <AgentStatusLine agent="scout" level="ok">PR #412 · reviewed in 1.8s · 2 findings</AgentStatusLine>
            <AgentStatusLine agent="sentinel" level="block">api_key hardcoded @ src/auth.ts:42</AgentStatusLine>
            <AgentStatusLine agent="tinker" level="warn">payment.ts:processOrder() exceeds 180 lines</AgentStatusLine>
            <AgentStatusLine agent="beacon" level="pending">next downlink in 3d · no unread findings</AgentStatusLine>
            <AgentStatusLine agent="archive">47 decisions logged · ask &quot;why did we drop redis?&quot;</AgentStatusLine>
          </div>
        </Section>

        {/* ROVER BADGES */}
        <Section eyebrow="Rover Fleet">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <RoverBadge unit={1} name="Scout" role="pr-review agent" status="online">
              Reviews every PR the moment it opens.
            </RoverBadge>
            <RoverBadge unit={2} name="Tinker" role="refactor agent" status="online">
              Drafts refactor PRs for long functions and circular deps.
            </RoverBadge>
            <RoverBadge unit={3} name="Sentinel" role="security agent" status="patrolling">
              Real-time patrol for secrets and missing auth.
            </RoverBadge>
            <RoverBadge unit={4} name="Beacon" role="health-report agent" status="armed">
              Weekly code-health digest to Slack or email.
            </RoverBadge>
            <RoverBadge unit={5} name="Archive" role="decision-memory agent" status="online">
              Persistent memory of every architectural decision.
            </RoverBadge>
          </div>
        </Section>

        {/* PROOF ROW */}
        <Section eyebrow="Proof Row">
          <ProofRow
            items={[
              { label: '1st PR review', value: '≤ 2 min' },
              { label: 'Onboarding', value: '3 mo → 2 wk' },
              { label: 'Secrets caught', value: 'pre-commit' },
              { label: 'Self-hosted', value: 'your infra' },
            ]}
          />
        </Section>

        {/* COMPARE TABLE */}
        <Section eyebrow="Compare Table">
          <CompareTable
            columns={['Copilot', 'Sourcegraph', 'Snyk · Sonar', 'CodeRover']}
            highlightColumnIndex={3}
            rows={[
              { feature: 'Autonomous PR review', cells: ['—', '—', '—', '✓ Scout'] },
              { feature: 'Refactor proposals (as PRs)', cells: ['manual', '—', '—', '✓ Tinker'] },
              { feature: 'Security patrol', cells: ['—', '—', '✓', '✓ Sentinel'] },
              { feature: 'Decision memory (persistent)', cells: ['—', '—', '—', '✓ Archive'] },
              { feature: 'MCP-native', cells: ['—', '—', '—', '✓'] },
              { feature: 'Self-hosted', cells: ['—', '✓', '✓', '✓'] },
            ]}
          />
        </Section>

        <footer className="mt-16 border-t border-border pt-8 font-mono text-xs text-muted-foreground">
          <p>§ End of primitives · Wave 2 · CodeRover Mission Control</p>
        </footer>
      </div>
    </div>
  );
}
