import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { useAuthStore } from './stores/authStore';
import { useThemeStore } from './stores/themeStore';
import Layout from './components/Layout/Layout';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import GithubCallbackPage from './pages/GithubCallbackPage';
import DesignSystemPage from './pages/DesignSystemPage';
import DashboardPage from './pages/DashboardPage';
import ChatPage from './pages/ChatPage';
import ReposPage from './pages/ReposPage';
import HealthPage from './pages/HealthPage';
import ArtifactsPage from './pages/ArtifactsPage';
import SettingsPage from './pages/SettingsPage';
import OrgsPage from './pages/OrgsPage';
import PrReviewsPage from './pages/PrReviewsPage';
import OperationsPage from './pages/OperationsPage';
import RepoDetailPage from './pages/RepoDetailPage';
import SearchPage from './pages/SearchPage';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import RequireRole from './components/Auth/RequireRole';
import './App.css';

const GraphPage = lazy(() => import('./pages/GraphPage'));
const AgentDashboard = lazy(() => import('./pages/agent/AgentDashboard'));
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));

function PageLoader() {
  return (
    <div className="flex items-center justify-center min-h-[400px]">
      <div className="text-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500 mx-auto"></div>
        <p className="mt-3 text-sm text-muted-foreground">Loading...</p>
      </div>
    </div>
  );
}

function App() {
  const { isAuthenticated } = useAuthStore();
  const { theme } = useThemeStore();

  return (
    <div className={`min-h-screen bg-background text-foreground ${theme}`} data-theme={theme}>
      <BrowserRouter>
        <Routes>
          {/* Public routes */}
          <Route
            path="/login"
            element={!isAuthenticated ? <LoginPage /> : <Navigate to="/dashboard" replace />}
          />
          <Route
            path="/register"
            element={!isAuthenticated ? <RegisterPage /> : <Navigate to="/dashboard" replace />}
          />
          <Route path="/auth/github/callback" element={<GithubCallbackPage />} />
          <Route path="/design-system" element={<DesignSystemPage />} />

          {/* Protected routes */}
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<ErrorBoundary><DashboardPage /></ErrorBoundary>} />
              <Route path="/chat" element={<ErrorBoundary><ChatPage /></ErrorBoundary>} />
              <Route path="/chat/:sessionId" element={<ErrorBoundary><ChatPage /></ErrorBoundary>} />
              <Route path="/search" element={<ErrorBoundary><SearchPage /></ErrorBoundary>} />
              <Route path="/repos" element={<ErrorBoundary><ReposPage /></ErrorBoundary>} />
              <Route path="/repos/:id" element={<ErrorBoundary><RepoDetailPage /></ErrorBoundary>} />
              <Route path="/graph" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><GraphPage /></Suspense></ErrorBoundary>} />
              <Route path="/agents" element={<ErrorBoundary><RequireRole role="admin"><Suspense fallback={<PageLoader />}><AgentDashboard /></Suspense></RequireRole></ErrorBoundary>} />
              <Route path="/analytics" element={<ErrorBoundary><Suspense fallback={<PageLoader />}><AnalyticsPage /></Suspense></ErrorBoundary>} />
              <Route path="/health" element={<ErrorBoundary><HealthPage /></ErrorBoundary>} />
              <Route path="/artifacts" element={<ErrorBoundary><ArtifactsPage /></ErrorBoundary>} />
              <Route path="/pr-reviews" element={<ErrorBoundary><PrReviewsPage /></ErrorBoundary>} />
              <Route path="/operations" element={<ErrorBoundary><RequireRole role="admin"><OperationsPage /></RequireRole></ErrorBoundary>} />
              <Route path="/settings" element={<ErrorBoundary><RequireRole role="admin"><SettingsPage /></RequireRole></ErrorBoundary>} />
              <Route path="/orgs" element={<ErrorBoundary><OrgsPage /></ErrorBoundary>} />
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
            </Route>
          </Route>

          {/* Catch all route */}
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      
      <Toaster 
        position="top-right"
        expand={true}
        richColors
        closeButton
        duration={4000}
      />
    </div>
  );
}

export default App;
