import {
  CREDENTIAL_PATTERNS,
  countCredentialMatches,
  redactCredentials,
} from './credential-redactor.service';

/**
 * Tests for the pre-embedding credential scrub. Two axes:
 *   1. Each curated pattern matches a known-good real-world token shape
 *      and gets replaced with `[REDACTED:<TYPE>]`.
 *   2. Common false-positive hazards (test fixtures, hashes, base64 of
 *      arbitrary length, etc.) pass through unchanged.
 */
describe('redactCredentials', () => {
  describe('positive matches — high-confidence patterns', () => {
    const cases: Array<[string, string, string]> = [
      // [name, input fragment, expected REDACTED type]
      ['AWS access key (root)', 'AKIAIOSFODNN7EXAMPLE', 'AWS_ACCESS_KEY'],
      ['AWS access key (STS)', 'ASIAIOSFODNN7EXAMPLE', 'AWS_ACCESS_KEY'],
      ['GitHub PAT classic', 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GITHUB_PAT'],
      [
        'GitHub fine-grained PAT',
        'github_pat_' + 'A'.repeat(82),
        'GITHUB_PAT_FINE',
      ],
      ['GitHub OAuth user token', 'gho_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GITHUB_OAUTH'],
      ['GitHub install token', 'ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GITHUB_INSTALL'],
      ['GitHub user-to-server', 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GITHUB_USER_TO_SERVER'],
      ['GitHub refresh', 'ghr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'GITHUB_REFRESH'],
      [
        'Stripe live secret',
        // Split the literal so GitHub's push-protection scanner does
        // not see a canonical Stripe-prefix substring in source bytes.
        // At runtime JS concat yields the full pattern that our regex
        // matches.
        'sk_' + 'live_' + 'A'.repeat(24),
        'STRIPE_LIVE',
      ],
      [
        'Stripe restricted',
        'rk_' + 'test_' + 'A'.repeat(24),
        'STRIPE_RESTRICTED',
      ],
      [
        'Anthropic key',
        'sk-ant-' + 'A'.repeat(64),
        'ANTHROPIC_KEY',
      ],
      [
        'OpenAI project key',
        'sk-proj-' + 'A'.repeat(64),
        'OPENAI_PROJECT_KEY',
      ],
      [
        'Google API key',
        'AIza' + 'A'.repeat(35),
        'GOOGLE_API_KEY',
      ],
      [
        'Slack token (bot)',
        // Synthetic — matches \bxox[abprs]-[A-Za-z0-9-]{10,}\b without
        // resembling a real Slack token shape.
        'xoxb-AAAAAAAAAAAAAA',
        'SLACK_TOKEN',
      ],
      [
        'PEM private key block (RSA, full BEGIN..END)',
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAA==\n-----END RSA PRIVATE KEY-----',
        'PRIVATE_KEY_PEM',
      ],
      [
        'PEM private key block (no algo, full BEGIN..END)',
        '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq==\n-----END PRIVATE KEY-----',
        'PRIVATE_KEY_PEM',
      ],
    ];

    it.each(cases)('redacts %s', (_, input, expectedType) => {
      const out = redactCredentials(`const secret = "${input}";`);
      expect(out).toBe(`const secret = "[REDACTED:${expectedType}]";`);
      expect(out).not.toContain(input);
    });
  });

  describe('negative — false-positive hazards pass through unchanged', () => {
    const passThrough = [
      // Plain code that happens to contain quoted strings
      'const x = "hello world";',
      // Hashes / base64 of arbitrary stuff (should NOT match — too generic)
      'const sha = "a3f2b4c8e1d09f7c6a8b2e4f1d3c5a7b9e0f2a4c6b8d";',
      // Test fixture that is NOT a real token format
      'const fakeToken = "this-is-not-a-token";',
      // OpenAI legacy `sk-` prefix WITHOUT the `proj-` discriminator —
      // intentionally NOT matched here because it false-positives on
      // base58/base64 strings. We only redact the new `sk-proj-*` format.
      'const k = "sk-1234567890abcdef1234567890abcdef";',
      // String that contains the literal text `ghp_` but is too short
      // to be a real PAT (which is exactly 36 base62 chars after the prefix).
      'const note = "see ghp_short for the format";',
      // PEM PUBLIC KEY (not private — must NOT match)
      '-----BEGIN PUBLIC KEY-----',
    ];

    it.each(passThrough)('does not redact: %s', input => {
      expect(redactCredentials(input)).toBe(input);
    });
  });

  describe('replacement format', () => {
    it('uses the canonical [REDACTED:<TYPE>] envelope', () => {
      const input = 'const a = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";';
      expect(redactCredentials(input)).toContain('[REDACTED:GITHUB_PAT]');
    });

    it('replaces multiple distinct credentials in one chunk', () => {
      const input = `
        const aws = "AKIAIOSFODNN7EXAMPLE";
        const gh = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      `;
      const out = redactCredentials(input);
      expect(out).toContain('[REDACTED:AWS_ACCESS_KEY]');
      expect(out).toContain('[REDACTED:GITHUB_PAT]');
      expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(out).not.toContain('ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    });

    it('replaces multiple instances of the same credential type', () => {
      const input = 'a=AKIAIOSFODNN7EXAMPLE b=AKIAJ0123456789ABCDE';
      const out = redactCredentials(input);
      expect(out).toBe('a=[REDACTED:AWS_ACCESS_KEY] b=[REDACTED:AWS_ACCESS_KEY]');
    });

    it('is idempotent — already-redacted text is unchanged', () => {
      const input = 'const a = "[REDACTED:GITHUB_PAT]";';
      expect(redactCredentials(input)).toBe(input);
    });

    it('preserves non-credential bytes exactly', () => {
      const input = '// AKIAIOSFODNN7EXAMPLE — replaced\nconst x = 1;\n';
      const out = redactCredentials(input);
      expect(out).toBe('// [REDACTED:AWS_ACCESS_KEY] — replaced\nconst x = 1;\n');
    });

    it('PEM lazy quantifier — two adjacent blocks redact independently', () => {
      // The regex uses `*?` so two separate PEM blocks must not collapse
      // into a single span across both.
      const input =
        '-----BEGIN PRIVATE KEY-----\nKEY1\n-----END PRIVATE KEY-----\n' +
        'middle bytes\n' +
        '-----BEGIN RSA PRIVATE KEY-----\nKEY2\n-----END RSA PRIVATE KEY-----';
      const out = redactCredentials(input);
      // Two replacement envelopes, the "middle bytes" line preserved verbatim.
      expect(out).toBe(
        '[REDACTED:PRIVATE_KEY_PEM]\nmiddle bytes\n[REDACTED:PRIVATE_KEY_PEM]',
      );
      expect(out).not.toContain('KEY1');
      expect(out).not.toContain('KEY2');
    });
  });
});

describe('countCredentialMatches', () => {
  it('returns empty object when no credentials are present', () => {
    expect(countCredentialMatches('const x = 1;')).toEqual({});
  });

  it('counts matches per credential type', () => {
    const input = `
      const a = "AKIAIOSFODNN7EXAMPLE";
      const b = "AKIAJ0123456789ABCDE";
      const c = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    `;
    const counts = countCredentialMatches(input);
    expect(counts.AWS_ACCESS_KEY).toBe(2);
    expect(counts.GITHUB_PAT).toBe(1);
  });
});

describe('CREDENTIAL_PATTERNS', () => {
  it('every pattern uses the global flag', () => {
    for (const p of CREDENTIAL_PATTERNS) {
      expect(p.regex.flags).toContain('g');
    }
  });

  it('every pattern has unique type identifiers (no duplicate REDACTED labels)', () => {
    const types = CREDENTIAL_PATTERNS.map(p => p.type);
    expect(new Set(types).size).toBe(types.length);
  });
});

// Imports for the metadata-aware redactors.
import {
  redactCallSites,
  redactImports,
  redactInheritance,
  redactJSONValue,
  redactMethods,
  redactStringList,
  redactSymbols,
} from './credential-redactor.service';

describe('redactJSONValue (Phase 4A — tool-result trees)', () => {
  it('redacts a credential at the top level (string)', () => {
    expect(redactJSONValue('AKIAIOSFODNN7EXAMPLE')).toBe('[REDACTED:AWS_ACCESS_KEY]');
  });

  it('passes primitives through unchanged', () => {
    expect(redactJSONValue(42)).toBe(42);
    expect(redactJSONValue(true)).toBe(true);
    expect(redactJSONValue(false)).toBe(false);
    expect(redactJSONValue(null)).toBeNull();
    expect(redactJSONValue(undefined)).toBeUndefined();
  });

  it('redacts every string in a flat object', () => {
    const out = redactJSONValue({
      a: 'safe',
      b: 'AKIAIOSFODNN7EXAMPLE',
      c: 1,
      d: true,
    }) as Record<string, unknown>;
    expect(out).toEqual({
      a: 'safe',
      b: '[REDACTED:AWS_ACCESS_KEY]',
      c: 1,
      d: true,
    });
  });

  it('redacts strings in nested arrays + objects', () => {
    const tree = {
      files: [
        {
          path: 'src/secrets.ts',
          content: 'const aws = "AKIAIOSFODNN7EXAMPLE";',
          lines: 1,
        },
        {
          path: 'src/auth.ts',
          content: 'export const TOKEN = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";',
          lines: 1,
        },
      ],
      meta: { count: 2, source: 'mcp.read_files' },
    };
    const out = redactJSONValue(tree) as typeof tree;
    expect(out.files[0].content).toBe('const aws = "[REDACTED:AWS_ACCESS_KEY]";');
    expect(out.files[1].content).toContain('[REDACTED:GITHUB_PAT]');
    expect(out.files[0].lines).toBe(1);
    expect(out.meta).toEqual({ count: 2, source: 'mcp.read_files' });
  });

  it('does not mutate the input tree', () => {
    const input = {
      content: 'const aws = "AKIAIOSFODNN7EXAMPLE";',
      kids: [{ leaf: 'AKIAIOSFODNN7EXAMPLE' }],
    };
    const snapshot = JSON.parse(JSON.stringify(input));
    redactJSONValue(input);
    expect(input).toEqual(snapshot);
  });

  it('handles arrays at the top level', () => {
    const out = redactJSONValue(['safe', 'AKIAIOSFODNN7EXAMPLE', 42]);
    expect(out).toEqual(['safe', '[REDACTED:AWS_ACCESS_KEY]', 42]);
  });
});

describe('metadata-aware redactors (Phase 3C, chunker JSONB columns)', () => {
  it('redactStringList scrubs every string in an array', () => {
    expect(
      redactStringList(['safe', 'AKIAIOSFODNN7EXAMPLE', 'also-safe']),
    ).toEqual(['safe', '[REDACTED:AWS_ACCESS_KEY]', 'also-safe']);
  });

  it('redactSymbols scrubs name + decorators, preserves other fields', () => {
    const input = [
      {
        name: 'AKIAIOSFODNN7EXAMPLE',
        kind: 'const',
        exported: true,
        decorators: ['Injectable', 'AKIAIOSFODNN7EXAMPLE'],
        lineStart: 10,
        lineEnd: 12,
      },
    ];
    const out = redactSymbols(input);
    expect(out[0].name).toBe('[REDACTED:AWS_ACCESS_KEY]');
    expect(out[0].decorators).toEqual(['Injectable', '[REDACTED:AWS_ACCESS_KEY]']);
    expect(out[0].kind).toBe('const');
    expect(out[0].lineStart).toBe(10);
    expect(out[0].lineEnd).toBe(12);
    expect(out[0].exported).toBe(true);
  });

  it('redactImports scrubs source + names, preserves isRelative', () => {
    const input = [{ source: '../akia', names: ['AKIAIOSFODNN7EXAMPLE', 'safe'], isRelative: true }];
    const out = redactImports(input);
    expect(out[0].names).toEqual(['[REDACTED:AWS_ACCESS_KEY]', 'safe']);
    expect(out[0].isRelative).toBe(true);
  });

  it('redactMethods scrubs name + className + parameters', () => {
    const input = [
      {
        name: 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        className: 'Service',
        startLine: 1,
        endLine: 5,
        parameters: ['x', 'AKIAIOSFODNN7EXAMPLE'],
      },
    ];
    const out = redactMethods(input);
    expect(out[0].name).toBe('[REDACTED:GITHUB_PAT]');
    expect(out[0].className).toBe('Service');
    expect(out[0].parameters).toEqual(['x', '[REDACTED:AWS_ACCESS_KEY]']);
    expect(out[0].startLine).toBe(1);
    expect(out[0].endLine).toBe(5);
  });

  it('redactCallSites scrubs all three name fields', () => {
    const input = [
      {
        callerName: 'caller',
        callerKind: 'function' as const,
        calleeName: 'AKIAIOSFODNN7EXAMPLE',
        calleeQualified: 'utils.AKIAIOSFODNN7EXAMPLE',
        line: 42,
      },
    ];
    const out = redactCallSites(input);
    expect(out[0].calleeName).toBe('[REDACTED:AWS_ACCESS_KEY]');
    expect(out[0].calleeQualified).toBe('utils.[REDACTED:AWS_ACCESS_KEY]');
    expect(out[0].callerName).toBe('caller');
    expect(out[0].line).toBe(42);
    expect(out[0].callerKind).toBe('function');
  });

  it('redactInheritance scrubs className + extends + implements', () => {
    const input = [
      {
        className: 'Child',
        extends: 'AKIAIOSFODNN7EXAMPLE',
        implements: ['IFoo', 'AKIAIOSFODNN7EXAMPLE'],
      },
    ];
    const out = redactInheritance(input);
    expect(out[0].extends).toBe('[REDACTED:AWS_ACCESS_KEY]');
    expect(out[0].implements).toEqual(['IFoo', '[REDACTED:AWS_ACCESS_KEY]']);
    expect(out[0].className).toBe('Child');
  });

  it('redactInheritance preserves null extends', () => {
    const out = redactInheritance([{ className: 'C', extends: null, implements: [] }]);
    expect(out[0].extends).toBeNull();
  });

  it('all helpers leave non-credential strings exactly alone', () => {
    const symbols = [
      { name: 'BookingService', kind: 'class' as const, exported: true, decorators: ['Injectable'], lineStart: 1, lineEnd: 50 },
    ];
    expect(redactSymbols(symbols)).toEqual(symbols);
  });
});
