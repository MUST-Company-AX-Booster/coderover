import { Component, ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex items-center justify-center min-h-[300px] p-8">
          <div className="text-center max-w-md">
            <div className="w-12 h-12 bg-error-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <AlertTriangle className="h-6 w-6 text-error-500" />
            </div>
            <h3 className="text-lg font-semibold text-foreground mb-2">Something went wrong</h3>
            <p className="text-sm text-muted-foreground mb-4">
              An unexpected error occurred while rendering this section.
            </p>
            {this.state.error && (
              <pre className="text-xs text-error-600 bg-error-50 rounded-lg p-3 mb-4 text-left overflow-x-auto">
                {this.state.error.message}
              </pre>
            )}
            <button onClick={this.handleReset} className="btn btn-primary inline-flex items-center gap-2">
              <RefreshCw className="h-4 w-4" />
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
