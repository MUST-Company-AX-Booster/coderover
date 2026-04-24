import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';
import { toast } from 'sonner';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

/**
 * Phase 10 (2026-04-16): the backend no longer puts app tokens in the URL.
 * Instead the callback redirects here with `?code=<github-code>&state=...`
 * and this page POSTs the code to `/auth/github/exchange`. App tokens
 * land in the response body only — never in the URL bar, server logs,
 * or browser history.
 */
export default function GithubCallbackPage() {
  const navigate = useNavigate();
  const { completeOAuthLogin } = useAuthStore();
  // Guard against React StrictMode double-invocation: the GitHub code is
  // single-use, and running the effect twice would fail the second try
  // with "bad_verification_code" and surface a false error to the user.
  const hasRun = useRef(false);

  useEffect(() => {
    if (hasRun.current) return;
    hasRun.current = true;

    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    const code = params.get('code');
    // Keep reading legacy token params for one release so users mid-flow
    // during the deploy don't get stuck on a broken redirect.
    const legacyAccessToken = params.get('accessToken');
    const legacyEmail = params.get('email');
    const legacyUserId = params.get('userId');
    const legacyRole = params.get('role') || 'admin';
    const legacyName = params.get('name') || undefined;

    if (error) {
      toast.error(error);
      navigate('/login', { replace: true });
      return;
    }

    if (legacyAccessToken && legacyEmail && legacyUserId) {
      // Legacy-flow fallback — remove after 1 release.
      completeOAuthLogin({
        accessToken: legacyAccessToken,
        user: {
          id: legacyUserId,
          email: legacyEmail,
          role: legacyRole,
          name: legacyName,
        },
      });
      toast.success('Signed in with GitHub');
      navigate('/dashboard', { replace: true });
      return;
    }

    if (!code) {
      toast.error('GitHub login failed — missing authorization code');
      navigate('/login', { replace: true });
      return;
    }

    (async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/auth/github/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.message || 'GitHub exchange failed');
        }
        const data = await response.json();
        const accessToken = data.accessToken || data.access_token;
        if (!accessToken || !data.user) {
          throw new Error('GitHub exchange response missing tokens');
        }
        completeOAuthLogin({
          accessToken,
          user: {
            id: data.user.id,
            email: data.user.email,
            role: data.user.role,
            name: data.user.name,
          },
        });
        toast.success('Signed in with GitHub');
        navigate('/dashboard', { replace: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'GitHub login failed';
        toast.error(msg);
        navigate('/login', { replace: true });
      }
    })();
  }, [completeOAuthLogin, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-500 mx-auto"></div>
        <p className="mt-4 text-sm text-muted-foreground">Completing GitHub sign-in...</p>
      </div>
    </div>
  );
}
