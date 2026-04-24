import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiClient, API_BASE_URL, getAuthHeaders } from './client';

describe('API Client', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    localStorage.clear();
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('getAuthHeaders', () => {
    it('returns empty object when no token stored', () => {
      expect(getAuthHeaders()).toEqual({});
    });

    it('returns Authorization header when token exists in auth-storage', () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'test-jwt-token', isAuthenticated: true, user: null },
      }));
      expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer test-jwt-token' });
    });

    it('falls back to auth_token localStorage key', () => {
      localStorage.setItem('auth_token', 'fallback-token');
      expect(getAuthHeaders()).toEqual({ Authorization: 'Bearer fallback-token' });
    });
  });

  describe('apiClient.get', () => {
    it('makes GET request with auth headers', async () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'my-token', isAuthenticated: true, user: null },
      }));

      const mockResponse = { ok: true, status: 200, json: () => Promise.resolve({ data: 'test' }) };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await apiClient.get('/test-endpoint');

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/test-endpoint`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-token',
            'Content-Type': 'application/json',
          }),
        }),
      );
      expect(result).toEqual({ data: 'test' });
    });

    it('handles 204 No Content', async () => {
      const mockResponse = { ok: true, status: 204, json: () => Promise.reject('no body') };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      const result = await apiClient.get('/empty');
      expect(result).toBeUndefined();
    });

    it('throws on non-ok response', async () => {
      const mockResponse = {
        ok: false, status: 400,
        json: () => Promise.resolve({ message: 'Bad request' }),
      };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await expect(apiClient.get('/bad')).rejects.toThrow('Bad request');
    });
  });

  describe('apiClient.post', () => {
    it('sends JSON body', async () => {
      const mockResponse = { ok: true, status: 200, json: () => Promise.resolve({ id: 1 }) };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      await apiClient.post('/create', { name: 'test' });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        `${API_BASE_URL}/create`,
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'test' }),
        }),
      );
    });
  });

  describe('401 handling', () => {
    it('clears auth state and redirects on 401', async () => {
      localStorage.setItem('auth-storage', JSON.stringify({
        state: { token: 'expired', isAuthenticated: true, user: { id: '1' } },
      }));
      localStorage.setItem('auth_token', 'expired');

      const mockResponse = { ok: false, status: 401, json: () => Promise.resolve({}) };
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

      // Mock window.location
      const originalHref = window.location.href;
      Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });

      await expect(apiClient.get('/protected')).rejects.toThrow('Authentication required');

      expect(localStorage.getItem('auth_token')).toBeNull();
      expect(window.location.href).toBe('/login');

      // Restore
      Object.defineProperty(window, 'location', { value: { href: originalHref }, writable: true });
    });
  });
});
