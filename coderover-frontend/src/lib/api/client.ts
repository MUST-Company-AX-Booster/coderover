/**
 * Centralized API client for CodeRover.
 * Handles auth headers, 401 logout, and error parsing.
 */

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/** Get the stored auth token (Zustand store or localStorage fallback) */
const getToken = (): string | null => {
  try {
    const raw = localStorage.getItem('auth-storage');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.state?.token) return parsed.state.token;
    }
  } catch { /* ignore */ }
  return localStorage.getItem('auth_token');
};

/** Build Authorization header from stored token */
export const getAuthHeaders = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export type RequestOptions = RequestInit & {
  suppressAuthLogout?: boolean;
};

const request = async <T>(url: string, options: RequestOptions = {}): Promise<T> => {
  const { suppressAuthLogout = false, ...fetchOptions } = options;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(),
    ...(fetchOptions.headers as Record<string, string> || {}),
  };

  const response = await fetch(`${API_BASE_URL}${url}`, {
    ...fetchOptions,
    headers,
  });

  if (response.status === 401) {
    if (!suppressAuthLogout) {
      // Clear auth state
      localStorage.removeItem('auth_token');
      try {
        const raw = localStorage.getItem('auth-storage');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed?.state) {
            parsed.state.token = null;
            parsed.state.isAuthenticated = false;
            parsed.state.user = null;
            localStorage.setItem('auth-storage', JSON.stringify(parsed));
          }
        }
      } catch { /* ignore */ }
      window.location.href = '/login';
    }
    throw new Error('Authentication required');
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(errorData.message || 'Request failed');
  }

  // Handle 204 No Content
  if (response.status === 204) return undefined as T;

  return response.json();
};

export const apiClient = {
  request,

  async get<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(url, { method: 'GET', ...options });
  },

  async post<T>(url: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(url, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
      ...options,
    });
  },

  async put<T>(url: string, data?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(url, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
      ...options,
    });
  },

  async delete<T>(url: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(url, { method: 'DELETE', ...options });
  },
};
