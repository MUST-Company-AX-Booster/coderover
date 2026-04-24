import { Injectable, Logger } from '@nestjs/common';

export type SupportedLanguage =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'java'
  | 'kotlin'
  | 'rust'
  | 'swift'
  | 'php'
  | 'vue'
  | 'css'
  | 'html'
  | 'markdown'
  | 'yaml'
  | 'json'
  | 'terraform'
  | 'sql'
  | 'unknown';

export type SupportedFramework =
  | 'nestjs'
  | 'nextjs'
  | 'vite-react'
  | 'vite-vue'
  | 'angular'
  | 'svelte'
  | 'sveltekit'
  | 'nuxt'
  | 'express'
  | 'fastapi'
  | 'django'
  | 'spring'
  | 'unknown';

/** Config files that indicate a specific framework */
const FRAMEWORK_SIGNALS: Array<{ file: string; framework: SupportedFramework }> = [
  { file: 'next.config.js', framework: 'nextjs' },
  { file: 'next.config.ts', framework: 'nextjs' },
  { file: 'next.config.mjs', framework: 'nextjs' },
  { file: 'vite.config.ts', framework: 'vite-react' },   // refined by content below
  { file: 'vite.config.js', framework: 'vite-react' },
  { file: 'vite.config.mts', framework: 'vite-react' },
  { file: 'angular.json', framework: 'angular' },
  { file: '.angular-cli.json', framework: 'angular' },
  { file: 'svelte.config.js', framework: 'svelte' },
  { file: 'svelte.config.ts', framework: 'svelte' },
  { file: 'nuxt.config.ts', framework: 'nuxt' },
  { file: 'nuxt.config.js', framework: 'nuxt' },
];

/** Extension → language mapping */
const EXT_TO_LANGUAGE: Record<string, SupportedLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.rs': 'rust',
  '.swift': 'swift',
  '.php': 'php',
  '.vue': 'vue',
  '.css': 'css',
  '.scss': 'css',
  '.less': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.json': 'json',
  '.tf': 'terraform',
  '.tfvars': 'terraform',
  '.sql': 'sql',
};

@Injectable()
export class LanguageDetectorService {
  private readonly logger = new Logger(LanguageDetectorService.name);

  /**
   * Detect the programming language from a file path.
   */
  detectLanguage(filePath: string): SupportedLanguage {
    const lower = filePath.toLowerCase();

    // Check extension first
    for (const [ext, lang] of Object.entries(EXT_TO_LANGUAGE)) {
      if (lower.endsWith(ext)) {
        return lang;
      }
    }

    // Filename-based fallbacks
    const basename = lower.split('/').pop() ?? '';
    if (basename === 'dockerfile' || basename.startsWith('dockerfile.')) return 'unknown';
    if (basename === 'makefile') return 'unknown';

    return 'unknown';
  }

  /**
   * Detect the frontend/backend framework from a list of file paths in the repo root.
   * Also uses vite config content to distinguish vite-react vs vite-vue.
   */
  detectFramework(
    filePaths: string[],
    fileContents: Map<string, string> = new Map(),
  ): SupportedFramework {
    // Check for NestJS — look for @nestjs/core in package.json
    const pkgContent = fileContents.get('package.json') ?? '';
    if (pkgContent.includes('@nestjs/core')) return 'nestjs';

    // Check config file signals
    const rootFiles = new Set(
      filePaths
        .filter((fp) => !fp.includes('/') || fp.split('/').length <= 2)
        .map((fp) => fp.split('/').pop()?.toLowerCase() ?? ''),
    );

    for (const signal of FRAMEWORK_SIGNALS) {
      const basename = signal.file.toLowerCase();
      if (rootFiles.has(basename)) {
        // Refine vite config: check content for @vitejs/plugin-vue
        if (signal.framework === 'vite-react') {
          const viteContent =
            fileContents.get('vite.config.ts') ??
            fileContents.get('vite.config.js') ??
            fileContents.get('vite.config.mts') ??
            '';
          if (viteContent.includes('@vitejs/plugin-vue') || viteContent.includes('vue()')) {
            return 'vite-vue';
          }
          // Check for SvelteKit inside vite config
          if (viteContent.includes('@sveltejs/kit') || viteContent.includes('sveltekit')) {
            return 'sveltekit';
          }
          return 'vite-react';
        }
        return signal.framework;
      }
    }

    // Python frameworks
    if (pkgContent === '' && fileContents.has('requirements.txt')) {
      const reqs = fileContents.get('requirements.txt') ?? '';
      if (reqs.includes('fastapi')) return 'fastapi';
      if (reqs.includes('django')) return 'django';
    }

    // Spring Boot
    if (
      filePaths.some(
        (fp) => fp.includes('pom.xml') || fp.includes('build.gradle'),
      )
    ) {
      const pom = fileContents.get('pom.xml') ?? '';
      if (pom.includes('spring-boot')) return 'spring';
    }

    // Express (JS without a major framework config)
    if (pkgContent.includes('"express"')) return 'express';

    return 'unknown';
  }

  /**
   * Get the NestJS-specific role for a file path based on detected framework.
   * Extends the existing nestRole detection to support other frameworks.
   */
  getFrameworkRole(
    filePath: string,
    framework: SupportedFramework,
  ): string | null {
    const lower = filePath.toLowerCase();
    const basename = lower.split('/').pop() ?? '';

    switch (framework) {
      case 'nextjs': {
        if (basename === 'page.tsx' || basename === 'page.ts' || basename === 'page.jsx') return 'page';
        if (basename === 'layout.tsx' || basename === 'layout.ts') return 'layout';
        if (basename === 'loading.tsx') return 'loading';
        if (basename === 'error.tsx') return 'error';
        if (lower.includes('/api/') && (basename === 'route.ts' || basename === 'route.js')) return 'api-route';
        if (lower.includes('middleware')) return 'middleware';
        if (lower.includes('/components/') || lower.includes('/component/')) return 'component';
        if (lower.includes('/hooks/') || basename.startsWith('use')) return 'hook';
        if (lower.includes('/lib/') || lower.includes('/utils/')) return 'utility';
        if (lower.includes('/types/') || lower.includes('/interfaces/')) return 'type';
        return 'component';
      }

      case 'vite-react': {
        if (lower.includes('/hooks/') || basename.startsWith('use')) return 'hook';
        if (lower.includes('/store/') || lower.includes('/redux/') || lower.includes('/zustand/')) return 'store';
        if (lower.includes('/services/') || lower.includes('/api/')) return 'service';
        if (lower.includes('/utils/') || lower.includes('/helpers/')) return 'utility';
        if (lower.includes('/types/') || lower.includes('/interfaces/')) return 'type';
        if (basename.endsWith('.tsx') || basename.endsWith('.jsx')) {
          if (lower.includes('/pages/') || lower.includes('/views/')) return 'page';
          return 'component';
        }
        return null;
      }

      case 'vite-vue': {
        if (lower.includes('/stores/') || lower.includes('/pinia/') || lower.includes('/store/')) return 'store';
        if (lower.includes('/composables/') || basename.startsWith('use')) return 'composable';
        if (lower.includes('/services/') || lower.includes('/api/')) return 'service';
        if (lower.includes('/utils/') || lower.includes('/helpers/')) return 'utility';
        if (lower.includes('/types/') || lower.includes('/interfaces/')) return 'type';
        if (basename.endsWith('.vue')) {
          if (lower.includes('/views/') || lower.includes('/pages/')) return 'view';
          if (lower.includes('/layouts/')) return 'layout';
          return 'component';
        }
        return null;
      }

      case 'angular': {
        if (basename.includes('.component.')) return 'component';
        if (basename.includes('.service.')) return 'service';
        if (basename.includes('.module.')) return 'module';
        if (basename.includes('.guard.')) return 'guard';
        if (basename.includes('.interceptor.')) return 'interceptor';
        if (basename.includes('.pipe.')) return 'pipe';
        if (basename.includes('.directive.')) return 'directive';
        if (basename.includes('.resolver.')) return 'resolver';
        if (basename.includes('.model.') || basename.includes('.interface.')) return 'model';
        return null;
      }

      case 'svelte':
      case 'sveltekit': {
        if (basename === '+server.ts' || basename === '+server.js') return 'api-route';
        if (lower.includes('/stores/') || lower.includes('/store.')) return 'store';
        if (basename === '+page.svelte') return 'page';
        if (basename === '+layout.svelte' || lower.includes('/layouts/')) return 'layout';
        if (basename === '+error.svelte') return 'error';
        if (basename.endsWith('.svelte')) {
          if (lower.includes('/routes/')) return 'route';
          return 'component';
        }
        if (lower.includes('/lib/')) return 'utility';
        return null;
      }

      case 'fastapi':
      case 'django': {
        if (basename === 'models.py' || basename.includes('model')) return 'model';
        if (basename === 'views.py' || basename.includes('view')) return 'view';
        if (basename === 'serializers.py') return 'serializer';
        if (basename === 'urls.py' || basename.includes('router') || lower.includes('/routers/')) return 'router';
        if (basename === 'schemas.py' || basename.includes('schema')) return 'schema';
        if (basename === 'middleware.py' || basename.includes('middleware')) return 'middleware';
        if (basename === 'settings.py' || basename === 'config.py') return 'config';
        return null;
      }

      default:
        return null;
    }
  }
}
