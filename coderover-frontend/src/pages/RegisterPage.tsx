import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { Wordmark, Kicker, Eyebrow } from '@/components/brand';
import { toast } from 'sonner';
import { useAuthStore } from '../stores/authStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';

const registerSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

type RegisterFormData = z.infer<typeof registerSchema>;

export default function RegisterPage() {
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuthStore();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<RegisterFormData>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: '', email: '', password: '', confirmPassword: '' },
  });

  const onSubmit = async (data: RegisterFormData) => {
    setIsSubmitting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: data.email,
          password: data.password,
          name: data.name,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ message: 'Registration failed' }));
        throw new Error(errorData.message || 'Registration failed');
      }

      toast.success('Account created! Signing you in...');

      // Auto-login after registration
      await login(data.email, data.password);
      navigate('/dashboard', { replace: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="flex flex-col items-center gap-5 mb-8">
          <Kicker status="armed">Mission Control · enlistment</Kicker>
          <Wordmark size="md" />
          <Eyebrow>Create credentials to command the fleet</Eyebrow>
        </div>

        {/* Register Card */}
        <Card className="border-border/80 bg-card">
          <CardHeader className="pb-4">
            <CardTitle className="text-xl">Welcome aboard, commander.</CardTitle>
            <CardDescription className="font-mono text-xs text-muted-foreground">
              [coderover] create credentials to continue
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
              <div className="space-y-2">
                <label htmlFor="name" className="text-sm font-medium">
                  Name
                </label>
                <Input
                  {...register('name')}
                  type="text"
                  id="name"
                  placeholder="John Doe"
                  disabled={isSubmitting}
                  className={errors.name ? 'border-destructive' : ''}
                />
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email
                </label>
                <Input
                  {...register('email')}
                  type="email"
                  id="email"
                  placeholder="you@example.com"
                  disabled={isSubmitting}
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
                    placeholder="Min. 6 characters"
                    disabled={isSubmitting}
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

              <div className="space-y-2">
                <label htmlFor="confirmPassword" className="text-sm font-medium">
                  Confirm Password
                </label>
                <Input
                  {...register('confirmPassword')}
                  type={showPassword ? 'text' : 'password'}
                  id="confirmPassword"
                  placeholder="Re-enter password"
                  disabled={isSubmitting}
                  className={errors.confirmPassword ? 'border-destructive' : ''}
                />
                {errors.confirmPassword && (
                  <p className="text-xs text-destructive">{errors.confirmPassword.message}</p>
                )}
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  'Create account'
                )}
              </Button>
            </form>

            <p className="text-center text-sm text-muted-foreground mt-6">
              Already have an account?{' '}
              <Link to="/login" className="text-accent hover:text-accent/80 font-medium underline decoration-dotted underline-offset-4">
                Sign in
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
