import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAuthStore } from './authStore';

describe('Auth Store', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset store state
    useAuthStore.setState({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
    });
  });

  it('starts with unauthenticated state', () => {
    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
  });

  it('login sets token and user on success', async () => {
    const mockResponse = {
      ok: true,
      json: () => Promise.resolve({
        accessToken: 'jwt-123',
        user: { id: 'u1', email: 'test@example.com', role: 'admin' },
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await useAuthStore.getState().login('test@example.com', 'password');

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.token).toBe('jwt-123');
    expect(state.user?.email).toBe('test@example.com');
    expect(localStorage.getItem('auth_token')).toBe('jwt-123');
  });

  it('login sets error on failure', async () => {
    const mockResponse = {
      ok: false,
      json: () => Promise.resolve({ message: 'Invalid credentials' }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    await expect(useAuthStore.getState().login('bad@example.com', 'wrong')).rejects.toThrow('Invalid credentials');

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.error).toBe('Invalid credentials');
  });

  it('completeOAuthLogin sets auth state', () => {
    useAuthStore.getState().completeOAuthLogin({
      accessToken: 'oauth-token',
      user: { id: 'gh-user', email: 'gh@example.com', name: 'GitHub User' },
    });

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.token).toBe('oauth-token');
    expect(state.user?.name).toBe('GitHub User');
  });

  it('logout clears all state', () => {
    useAuthStore.setState({
      user: { id: '1', email: 'test@test.com' },
      token: 'some-token',
      isAuthenticated: true,
    });
    localStorage.setItem('auth_token', 'some-token');

    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('setError and clearError work correctly', () => {
    useAuthStore.getState().setError('Something went wrong');
    expect(useAuthStore.getState().error).toBe('Something went wrong');

    useAuthStore.getState().clearError();
    expect(useAuthStore.getState().error).toBeNull();
  });
});
