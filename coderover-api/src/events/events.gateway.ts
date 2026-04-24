import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';

export interface AuthedSocketData {
  userId: string;
  role: string;
  orgId?: string;
}

/**
 * WebSocket gateway for Phase 9 realtime notifications.
 *
 * Clients connect to /events with ?token=<jwt> (or handshake.auth.token) and
 * subscribe to rooms via the `subscribe` message. Events are pushed by
 * EventsService via `publish(room, event, payload)`.
 *
 * Rooms (string conventions):
 *   user:<userId>
 *   org:<orgId>
 *   repo:<repoId>
 *   run:<agentRunId>
 */
@WebSocketGateway({
  namespace: '/events',
  cors: {
    origin: true,
    credentials: true,
  },
})
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EventsGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  handleConnection(client: Socket): void {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.query?.token as string | undefined);

      if (!token) {
        this.logger.warn(`Socket ${client.id} rejected: no token`);
        client.disconnect(true);
        return;
      }

      const secret = this.configService.get<string>('JWT_SECRET');
      const payload = this.jwtService.verify<any>(token, { secret });

      const data: AuthedSocketData = {
        userId: payload.sub ?? payload.userId,
        role: payload.role ?? 'user',
        orgId: payload.orgId,
      };
      client.data = data;

      // Auto-join user/org rooms
      client.join(`user:${data.userId}`);
      if (data.orgId) client.join(`org:${data.orgId}`);

      this.logger.log(`Socket ${client.id} connected as user=${data.userId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Socket ${client.id} auth failed: ${message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Socket ${client.id} disconnected`);
  }

  /**
   * Allow clients to subscribe to a specific room (repo:<id>, run:<id>, etc).
   * We keep this explicit rather than letting clients join arbitrary rooms
   * to avoid pollution of the room namespace.
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: string },
  ): { ok: boolean; room?: string; error?: string } {
    const room = body?.room;
    if (!room || typeof room !== 'string') {
      return { ok: false, error: 'room is required' };
    }
    // Allow only known prefixes — prevents clients from joining user:<other>
    const [prefix] = room.split(':');
    if (!['repo', 'run', 'review'].includes(prefix)) {
      return { ok: false, error: `room prefix '${prefix}' not allowed` };
    }
    client.join(room);
    return { ok: true, room };
  }

  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: { room?: string },
  ): { ok: boolean; room?: string } {
    const room = body?.room;
    if (!room) return { ok: false };
    client.leave(room);
    return { ok: true, room };
  }
}
