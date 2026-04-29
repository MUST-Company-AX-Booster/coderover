/**
 * call-extractor (JS/TS) tests — 0.5.0 B5.
 *
 * Gated on TS_REAL=1 because tree-sitter's native binding has
 * cross-spec invalidation that flakes under shared jest workers
 * (same gate the rest of the ingest tests use).
 */

import { extractJsCalls } from '../../../src/local/ingest/call-extractor';
import { parseFile } from '../../../src/local/ingest/grammar-loader';
import { treeSitterAvailable } from '../../helpers/tree-sitter-singleton';

const describeIfTs = treeSitterAvailable() ? describe : describe.skip;

describeIfTs('extractJsCalls (real tree-sitter)', () => {
  it('emits one edge per call inside a function body, with caller qualified', () => {
    const src = `
      function login(token) {
        const u = findUser(token);
        return generateToken(u.id);
      }
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/auth.js', tree });
    const summary = calls.map((c) => `${c.callerQualified} -> ${c.calleeName}@L${c.callLine}`);
    expect(summary).toEqual(
      expect.arrayContaining([
        'login -> findUser@L3',
        'login -> generateToken@L4',
      ]),
    );
  });

  it('attributes class methods with `Class.method` qualified caller', () => {
    const src = `
      class AuthService {
        verify(token) {
          return findUser(token);
        }
        login(name) {
          return this.verify(name);
        }
      }
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/auth.js', tree });
    const summary = calls.map((c) =>
      `${c.callerQualified} -> ${c.calleeQualified ?? c.calleeName}`,
    );
    expect(summary).toEqual(
      expect.arrayContaining([
        'AuthService.verify -> findUser',
        'AuthService.login -> this.verify',
      ]),
    );
  });

  it('member calls keep `obj.method` as calleeQualified, simple as calleeName', () => {
    const src = `
      function pay(svc, amount) {
        return svc.charge(amount);
      }
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/pay.js', tree });
    expect(calls).toHaveLength(1);
    expect(calls[0].calleeName).toBe('charge');
    expect(calls[0].calleeQualified).toBe('svc.charge');
  });

  it('skips calls outside any function (top-level expressions)', () => {
    const src = `
      console.log("boot");
      function inside() {
        console.log("inside");
      }
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/main.js', tree });
    // `console.log("boot")` is at top-level → skipped.
    // `console.log("inside")` is inside `inside` → kept.
    expect(calls).toHaveLength(1);
    expect(calls[0].callerQualified).toBe('inside');
  });

  it('handles arrow-function lexical_declaration as enclosing scope', () => {
    const src = `
      const greet = (name) => {
        return formatName(name);
      };
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/greet.js', tree });
    expect(calls).toHaveLength(1);
    expect(calls[0].callerQualified).toBe('greet');
    expect(calls[0].calleeName).toBe('formatName');
  });

  it('emits stable, distinct edge_ids for the same callee on different lines', () => {
    const src = `
      function loop() {
        retry();
        retry();
      }
    `;
    const tree = parseFile(src, 'javascript');
    const calls = extractJsCalls({ filePath: 'src/loop.js', tree });
    expect(calls).toHaveLength(2);
    expect(calls[0].edgeId).not.toBe(calls[1].edgeId);
  });
});
