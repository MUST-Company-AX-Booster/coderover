import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Re-export from centralized API client for backward compatibility
export { apiClient, getAuthHeaders } from '../lib/api/client';

interface User {
  id: string;
  email: string;
  name?: string;
  role?: string;
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  completeOAuthLogin: (payload: { accessToken: string; user: User }) => void;
  logout: () => void;
  setToken: (token: string) => void;
  setUser: (user: User) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  clearError: () => void;
}

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetch(`${API_BASE_URL}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          if (!response.ok) {
            const errorData = await response.json().catch(() => ({ message: 'Login failed' }));
            throw new Error(errorData.message || 'Login failed');
          }
          const data = await response.json();
          const accessToken = data.accessToken || data.access_token;
          const user = data.user || { id: email, email };
          if (!accessToken) throw new Error('Login response missing token');
          set({ token: accessToken, user, isAuthenticated: true, isLoading: false, error: null });
          localStorage.setItem('auth_token', accessToken);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Login failed';
          set({ isLoading: false, error: errorMessage, isAuthenticated: false });
          throw error;
        }
      },

      completeOAuthLogin: (payload: { accessToken: string; user: User }) => {
        set({ token: payload.accessToken, user: payload.user, isAuthenticated: true, isLoading: false, error: null });
        localStorage.setItem('auth_token', payload.accessToken);
      },

      logout: () => {
        set({ user: null, token: null, isAuthenticated: false, error: null });
        localStorage.removeItem('auth_token');
      },

      setToken: (token: string) => {
        set({ token, isAuthenticated: true });
        localStorage.setItem('auth_token', token);
      },
      setUser: (user: User) => set({ user }),
      setLoading: (loading: boolean) => set({ isLoading: loading }),
      setError: (error: string | null) => set({ error }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    },
  ),
);
