import { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
  Menu,
  X,
  Home,
  MessageSquare,
  Database,
  BarChart3,
  GitPullRequestArrow,
  Wrench,
  Heart,
  FileText,
  Settings,
  Sun,
  Moon,
  User,
  LogOut,
  Network,
  Bot,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
} from 'lucide-react';
import { Wordmark, Eyebrow } from '@/components/brand';
import { useAuthStore } from '../../stores/authStore';
import { useThemeStore } from '../../stores/themeStore';
import { useRoleAccess } from '../../hooks/useRoleAccess';
import { OrgSwitcher } from '../OrgSwitcher';
import { toast } from 'sonner';
import { Button } from '../ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../ui/tooltip';
import { Separator } from '../ui/separator';

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: Home },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Search', href: '/search', icon: Search },
  { name: 'Repositories', href: '/repos', icon: Database },
  { name: 'Graph', href: '/graph', icon: Network },
  { name: 'Agents', href: '/agents', icon: Bot, requiredRole: 'admin' as const },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Health', href: '/health', icon: Heart },
  { name: 'Artifacts', href: '/artifacts', icon: FileText },
  { name: 'PR Reviews', href: '/pr-reviews', icon: GitPullRequestArrow },
  { name: 'Operations', href: '/operations', icon: Wrench, requiredRole: 'admin' as const },
  { name: 'Settings', href: '/settings', icon: Settings, requiredRole: 'admin' as const },
  { name: 'Organizations', href: '/orgs', icon: Settings },
];

export default function Layout() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { theme, toggleTheme, sidebarCollapsed, toggleSidebar } = useThemeStore();
  const { isAdmin } = useRoleAccess();

  const filteredNavigation = navigation.filter((item) => {
    if (!item.requiredRole) return true;
    if (item.requiredRole === 'admin') return isAdmin;
    return true;
  });

  const handleLogout = () => {
    logout();
    toast.success('Logged out successfully');
  };

  const isActive = (path: string) =>
    location.pathname === path || location.pathname.startsWith(path + '/');

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location]);

  const sidebarWidth = sidebarCollapsed ? 'w-[68px]' : 'w-60';
  const mainPadding = sidebarCollapsed ? 'lg:pl-[68px]' : 'lg:pl-60';

  const NavItem = ({ item }: { item: typeof navigation[0] }) => {
    const Icon = item.icon;
    const active = isActive(item.href);

    const linkContent = (
      <Link
        to={item.href}
        className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150 ${
          sidebarCollapsed ? 'justify-center px-2' : ''
        } ${
          active
            ? 'bg-foreground/[0.06] text-foreground'
            : 'text-muted-foreground hover:bg-foreground/[0.03] hover:text-foreground'
        }`}
      >
        <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-accent' : ''}`} />
        {!sidebarCollapsed && <span className="truncate">{item.name}</span>}
      </Link>
    );

    if (sidebarCollapsed) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
          <TooltipContent side="right" className="text-xs">
            {item.name}
          </TooltipContent>
        </Tooltip>
      );
    }

    return linkContent;
  };

  return (
    <TooltipProvider delayDuration={0}>
      <div className="min-h-screen bg-background">
        {/* ── Mobile Overlay ── */}
        {mobileMenuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="fixed inset-0 bg-black/50 backdrop-blur-sm"
              onClick={() => setMobileMenuOpen(false)}
            />
            <div className="fixed inset-y-0 left-0 flex w-60 flex-col bg-card shadow-2xl border-r border-border">
              {/* Mobile header */}
              <div className="flex h-14 items-center justify-between px-4 border-b border-border">
                <Link to="/dashboard" className="flex items-center gap-2">
                  <Wordmark size="sm" glow={false} />
                </Link>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setMobileMenuOpen(false)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {/* Mobile nav */}
              <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
                {filteredNavigation.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href);
                  return (
                    <Link
                      key={item.name}
                      to={item.href}
                      className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                        active
                          ? 'bg-primary-500/10 text-primary-600'
                          : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      }`}
                    >
                      <Icon className={`h-[18px] w-[18px] shrink-0 ${active ? 'text-accent' : ''}`} />
                      <span>{item.name}</span>
                    </Link>
                  );
                })}
              </nav>
              {/* Mobile footer */}
              <div className="border-t border-border p-3 space-y-1">
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground truncate">
                  <User className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{user?.email}</span>
                </div>
                <button
                  onClick={handleLogout}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
                >
                  <LogOut className="h-[18px] w-[18px] shrink-0" />
                  <span>Logout</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Desktop Sidebar ── */}
        <aside
          className={`hidden lg:fixed lg:inset-y-0 lg:z-30 lg:flex ${sidebarWidth} lg:flex-col transition-all duration-200 ease-in-out`}
        >
          <div className="flex min-h-0 flex-1 flex-col bg-card border-r border-border">
            {/* Logo */}
            <div className="flex h-14 items-center justify-between px-3 border-b border-border">
              <Link to="/dashboard" className="flex items-center gap-2 overflow-hidden">
                {sidebarCollapsed ? (
                  <span
                    aria-label="CodeRover"
                    className="text-[22px] font-normal tracking-[0.02em] text-foreground"
                    style={{ fontFamily: '"Bokeh", "Cormorant Garamond", serif' }}
                  >
                    CR
                  </span>
                ) : (
                  <Wordmark size="sm" glow={false} />
                )}
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground"
                    onClick={toggleSidebar}
                  >
                    {sidebarCollapsed ? (
                      <PanelLeftOpen className="h-4 w-4" />
                    ) : (
                      <PanelLeftClose className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-xs">
                  {sidebarCollapsed ? 'Expand' : 'Collapse'}
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Nav items */}
            <nav className="flex-1 overflow-y-auto p-2 space-y-0.5">
              {filteredNavigation.map((item) => (
                <NavItem key={item.name} item={item} />
              ))}
            </nav>

            {/* Footer */}
            <div className="border-t border-border p-2 space-y-0.5">
              {!sidebarCollapsed && (
                <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground truncate">
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground/10">
                    <User className="h-3 w-3 text-foreground" />
                  </div>
                  <span className="truncate">{user?.name || user?.email?.split('@')[0]}</span>
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleLogout}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors ${
                      sidebarCollapsed ? 'justify-center px-2' : ''
                    }`}
                  >
                    <LogOut className="h-[18px] w-[18px] shrink-0" />
                    {!sidebarCollapsed && <span>Logout</span>}
                  </button>
                </TooltipTrigger>
                {sidebarCollapsed && (
                  <TooltipContent side="right" className="text-xs">
                    Logout
                  </TooltipContent>
                )}
              </Tooltip>
            </div>
          </div>
        </aside>

        {/* ── Main Content ── */}
        <div className={`${mainPadding} transition-all duration-200`}>
          {/* Top bar */}
          <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-card/80 backdrop-blur-md px-4 sm:px-6">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="lg:hidden h-8 w-8"
                onClick={() => setMobileMenuOpen(true)}
              >
                <Menu className="h-4 w-4" />
              </Button>
              <Eyebrow prefix className="text-[13px]">
                {filteredNavigation.find((n) => isActive(n.href))?.name || 'Mission Control'}
              </Eyebrow>
            </div>

            <div className="flex items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={toggleTheme}
                  >
                    {theme === 'dark' ? (
                      <Sun className="h-4 w-4" />
                    ) : (
                      <Moon className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </TooltipContent>
              </Tooltip>

              <Separator orientation="vertical" className="h-6" />

              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-foreground/10">
                  <User className="h-3.5 w-3.5 text-foreground" />
                </div>
                <span className="text-sm font-medium text-muted-foreground hidden sm:block">
                  {user?.name || user?.email?.split('@')[0]}
                </span>
                {isAdmin && (
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 border border-foreground/20 text-accent hidden sm:block">
                    admin
                  </span>
                )}
              </div>
              <OrgSwitcher />
            </div>
          </header>

          {/* Page content */}
          <main className="p-4 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
