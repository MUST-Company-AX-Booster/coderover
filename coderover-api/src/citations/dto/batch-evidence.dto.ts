import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsUUID,
} from 'class-validator';

/**
 * Phase 10 B4 — Batch-evidence request body.
 *
 * A chat page renders ~10 citations; issuing one GET per citation would cost
 * ten round-trips. Clients POST the full list of citation / finding UUIDs in
 * a single request; the server dedups, scopes by org, and returns an evidence
 * trail per id.
 *
 * Limits are load-bearing:
 *   - `ArrayNotEmpty`  — an empty batch is almost certainly a client bug.
 *   - `ArrayMaxSize(100)` — bulk-scrape prevention. A human-facing chat page
 *     tops out at ~20 citations; 100 is comfortably above that while still
 *     shutting down obvious abuse paths.
 *   - `@IsUUID('4', { each: true })` — rejects non-UUID garbage at the
 *     validation pipe so the service can assume every id is parseable.
 */
export class BatchEvidenceDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids!: string[];
}
