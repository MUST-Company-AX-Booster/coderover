import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

interface StateRecord {
  purpose: string;
  expiresAt: number;
}

/**
 * Short-lived, one-time-use OAuth `state` store for CSRF protection.
 *
 * Replaces the legacy `state = login-${Date.now()}` pattern which was
 * predictable and never validated on callback — classic CSRF vector.
 *
 * In-memory for single-container deploys (this repo). For horizontally
 * scaled deploys, swap the Map for a Redis-backed store (Bull already
 * provides a Redis connection that could be reused). The public API would
 * not change.
 */
@Injectable()
export class OAuthStateService {
  private readonly logger = new Logger(OAuthStateService.name);
  private readonly store = new Map<string, StateRecord>();
  private readonly TTL_MS = 10 * 60 * 1000; // 10 minutes

  constructor() {
    // Sweep expired entries every minute so the Map doesn't grow unbounded
    // in long-running processes. Single-container setup — no need for a
    // distributed cron.
    const timer = setInterval(() => this.sweep(), 60 * 1000);
    timer.unref?.();
  }

  /**
   * Mint a cryptographically random state token tied to a purpose label
   * (e.g. `'github-login'`). Caller embeds the returned string in the
   * OAuth authorize URL; callback must pass it back to `consume()`.
   */
  issue(purpose: string): string {
    const state = crypto.randomBytes(32).toString('base64url');
    this.store.set(state, {
      purpose,
      expiresAt: Date.now() + this.TTL_MS,
    });
    return state;
  }

  /**
   * Validate, consume (one-time), and return the stored record. Returns
   * null if the state is missing, expired, or already consumed. Callers
   * should ALSO verify the returned `purpose` matches what they expect.
   */
  consume(state: string): StateRecord | null {
    if (!state) return null;
    const record = this.store.get(state);
    if (!record) return null;

    // Always remove — single-use semantics even if expired.
    this.store.delete(state);

    if (record.expiresAt < Date.now()) {
      this.logger.debug(`OAuth state expired: ${state.slice(0, 8)}...`);
      return null;
    }

    return record;
  }

  private sweep(): void {
    const now = Date.now();
    let swept = 0;
    for (const [state, record] of this.store) {
      if (record.expiresAt < now) {
        this.store.delete(state);
        swept++;
      }
    }
    if (swept > 0) this.logger.debug(`Swept ${swept} expired OAuth state entries`);
  }
}
