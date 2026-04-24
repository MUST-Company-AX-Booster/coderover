import { useEffect } from 'react';
import { getSocket } from '../lib/events/socket';

interface EventPayload {
  event: string;
  payload: Record<string, unknown>;
  ts: number;
}

/**
 * Subscribe to a room and handle a specific event name.
 * Re-runs when room/event changes. Handler must be stable (useCallback)
 * or the effect will resubscribe on every render.
 */
export function useEventsSocket(
  room: string | null,
  event: string,
  handler: (payload: EventPayload['payload']) => void,
): void {
  useEffect(() => {
    if (!room) return;
    const socket = getSocket();
    if (!socket) return;

    const wrapped = (msg: EventPayload) => {
      if (msg?.payload) handler(msg.payload);
    };

    socket.emit('subscribe', { room });
    socket.on(event, wrapped);

    return () => {
      socket.off(event, wrapped);
      socket.emit('unsubscribe', { room });
    };
  }, [room, event, handler]);
}
