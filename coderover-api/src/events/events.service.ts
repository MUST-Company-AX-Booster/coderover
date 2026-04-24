import { Injectable, Logger } from '@nestjs/common';
import { EventsGateway } from './events.gateway';

/**
 * Thin facade over the gateway so other modules can emit events without
 * depending on socket.io types directly.
 *
 * Usage:
 *   eventsService.publish(`repo:${repoId}`, 'ingest.progress', { stage, pct });
 */
@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(private readonly gateway: EventsGateway) {}

  publish(room: string, event: string, payload: Record<string, unknown>): void {
    try {
      if (!this.gateway.server) {
        this.logger.debug(`Gateway not ready; dropping event ${event} on ${room}`);
        return;
      }
      this.gateway.server.to(room).emit(event, {
        event,
        payload,
        ts: Date.now(),
      });
    } catch (err) {
      // Never let event emission fail a caller's operation
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed to publish ${event} on ${room}: ${message}`);
    }
  }

  /** Emit to multiple rooms in one call (e.g. user + org + repo). */
  publishMany(rooms: string[], event: string, payload: Record<string, unknown>): void {
    for (const room of rooms) this.publish(room, event, payload);
  }
}
