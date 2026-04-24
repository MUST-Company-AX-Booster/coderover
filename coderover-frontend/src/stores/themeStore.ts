import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
  theme: 'light' | 'dark' | 'system';
  sidebarCollapsed: boolean;
  
  // Actions
  setTheme: (theme: 'light' | 'dark' | 'system') => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

// Detect system theme preference
const getSystemTheme = (): 'light' | 'dark' => {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

// Get effective theme (resolved from system preference if needed)
const getEffectiveTheme = (theme: 'light' | 'dark' | 'system'): 'light' | 'dark' => {
  if (theme === 'system') {
    return getSystemTheme();
  }
  return theme;
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'system',
      sidebarCollapsed: false,

      setTheme: (theme: 'light' | 'dark' | 'system') => {
        set({ theme });
        applyTheme(getEffectiveTheme(theme));
      },

      toggleTheme: () => {
        const currentTheme = get().theme;
        let newTheme: 'light' | 'dark' | 'system';
        
        if (currentTheme === 'system') {
          newTheme = getSystemTheme() === 'dark' ? 'light' : 'dark';
        } else {
          newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        }
        
        set({ theme: newTheme });
        applyTheme(getEffectiveTheme(newTheme));
      },

      toggleSidebar: () => {
        set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
      },

      setSidebarCollapsed: (collapsed: boolean) => {
        set({ sidebarCollapsed: collapsed });
      },
    }),
    {
      name: 'theme-storage',
      partialize: (state) => ({
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
      }),
    }
  )
);

// Apply theme to document
const applyTheme = (theme: 'light' | 'dark') => {
  if (typeof document === 'undefined') return;
  
  document.documentElement.setAttribute('data-theme', theme);
  
  // Update meta theme-color for mobile browsers
  const metaThemeColor = document.querySelector('meta[name="theme-color"]');
  if (metaThemeColor) {
    // Brand palette (DESIGN.md): void #0A0A0A for dark, bone #EDEBE5 for light
    metaThemeColor.setAttribute('content', theme === 'dark' ? '#0A0A0A' : '#EDEBE5');
  }
};

// Listen for system theme changes
if (typeof window !== 'undefined') {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  
  const handleSystemThemeChange = () => {
    const state = useThemeStore.getState();
    if (state.theme === 'system') {
      applyTheme(getSystemTheme());
    }
  };
  
  mediaQuery.addEventListener('change', handleSystemThemeChange);
  
  // Apply initial theme
  const initialTheme = getEffectiveTheme(useThemeStore.getState().theme);
  applyTheme(initialTheme);
}

// Utility function to get current effective theme
export const getCurrentTheme = (): 'light' | 'dark' => {
  const state = useThemeStore.getState();
  return getEffectiveTheme(state.theme);
};
