import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Github, Loader2 } from 'lucide-react';
import { useAuthStore } from '../stores/authStore';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Wordmark, Kicker, Eyebrow } from '@/components/brand';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [isGitHubLoading, setIsGitHubLoading] = useState(false);
  const { login, isLoading } = useAuthStore();
  const apiBaseUrl = import.meta.env.VITE_API_URL || 'http://localhost:3001';

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = async (data: LoginFormData) => {
    try {
      await login(data.email, data.password);
      toast.success('Welcome to CodeRover!');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Login failed');
    }
  };

  const handleGitHubLogin = async () => {
    try {
      setIsGitHubLoading(true);
      const response = await fetch(`${apiBaseUrl}/auth/github/connect?state=${encodeURIComponent(`login-${Date.now()}`)}`);
      if (!response.ok) throw new Error('Failed to initialize GitHub login');
      const payload = (await response.json()) as { authUrl?: string; configured?: boolean };
      if (!payload.configured || !payload.authUrl) throw new Error('GitHub OAuth is not configured');
      window.location.href = payload.authUrl;
    } catch (error) {
      setIsGitHubLoading(false);
      toast.error(error instanceof Error ? error.message : 'GitHub login failed');
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      toast.error(error);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center gap-5 mb-8">
          <Kicker status="live">Mission Control · v{__APP_VERSION__}</Kicker>
          <Wordmark size="md" />
          <Eyebrow>Sign in to operate the fleet</Eyebrow>
        </div>

        {/* Login Card */}
        <Card className="border-border/80 bg-card">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl">Welcome back, commander.</CardTitle>
            <CardDescription className="font-mono text-xs text-muted-foreground">
              [coderover] awaiting credentials
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  {...register('email')}
                  type="email"
                  id="email"
                  placeholder="you@example.com"
                  disabled={isLoading}
                  className={errors.email ? 'border-destructive' : ''}
                />
                {errors.email && (
                  <p className="text-xs text-destructive">{errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">
                  Password
                </label>
                <div className="relative">
                  <Input
                    {...register('password')}
                    type={showPassword ? 'text' : 'password'}
                    id="password"
                    placeholder="Enter password"
                    disabled={isLoading}
                    className={`pr-10 ${errors.password ? 'border-destructive' : ''}`}
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowPassword(!showPassword)}
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                {errors.password && (
                  <p className="text-xs text-destructive">{errors.password.message}</p>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  'Sign in'
                )}
              </Button>
            </form>

            <div className="relative my-6">
              <Separator />
              <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-card px-2 text-xs text-muted-foreground">
                or
              </span>
            </div>

            <Button
              variant="outline"
              className="w-full"
              disabled={isLoading || isGitHubLoading}
              onClick={handleGitHubLogin}
            >
              <Github className="h-4 w-4" />
              {isGitHubLoading ? 'Redirecting...' : 'Continue with GitHub'}
            </Button>

            <p className="text-center text-sm text-muted-foreground mt-4">
              Don&apos;t have an account?{' '}
              <Link to="/register" className="text-accent hover:text-accent/80 font-medium underline decoration-dotted underline-offset-4">
                Request access
              </Link>
            </p>
          </CardContent>
        </Card>

        <p className="mt-6 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/70">
          § self-hosted · your code never leaves
        </p>
      </div>
    </div>
  );
}
