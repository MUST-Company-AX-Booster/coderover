import { io, Socket } from 'socket.io-client';
import { useAuthStore } from '../../stores/authStore';

let socket: Socket | null = null;

function apiBase(): string {
  return (import.meta.env.VITE_API_BASE_URL as string) || 'http://localhost:3001';
}

/**
 * Lazy singleton socket. Connects to /events namespace with the current JWT
 * from authStore. Automatically reconnects when the token changes.
 */
export function getSocket(): Socket | null {
  const token = useAuthStore.getState().token;
  if (!token) return null;

  if (socket && socket.connected) return socket;

  socket = io(`${apiBase()}/events`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });

  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
