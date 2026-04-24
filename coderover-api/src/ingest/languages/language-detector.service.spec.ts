import { Test, TestingModule } from '@nestjs/testing';
import { LanguageDetectorService } from './language-detector.service';

describe('LanguageDetectorService', () => {
  let service: LanguageDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LanguageDetectorService],
    }).compile();
    service = module.get<LanguageDetectorService>(LanguageDetectorService);
  });

  // ── Language detection ────────────────────────────────────────────────────

  describe('detectLanguage', () => {
    it('detects TypeScript (.ts)', () => {
      expect(service.detectLanguage('src/app/service.ts')).toBe('typescript');
    });

    it('detects TypeScript (.tsx)', () => {
      expect(service.detectLanguage('src/components/Button.tsx')).toBe('typescript');
    });

    it('detects JavaScript (.js)', () => {
      expect(service.detectLanguage('src/utils/helper.js')).toBe('javascript');
    });

    it('detects JavaScript (.jsx)', () => {
      expect(service.detectLanguage('src/components/App.jsx')).toBe('javascript');
    });

    it('detects Python (.py)', () => {
      expect(service.detectLanguage('app/models.py')).toBe('python');
    });

    it('detects Go (.go)', () => {
      expect(service.detectLanguage('cmd/server/main.go')).toBe('go');
    });

    it('detects Java (.java)', () => {
      expect(service.detectLanguage('src/main/java/Service.java')).toBe('java');
    });

    it('detects Kotlin (.kt)', () => {
      expect(service.detectLanguage('src/main/kotlin/Controller.kt')).toBe('kotlin');
    });

    it('detects Rust (.rs)', () => {
      expect(service.detectLanguage('src/main.rs')).toBe('rust');
    });

    it('detects PHP (.php)', () => {
      expect(service.detectLanguage('src/Controller.php')).toBe('php');
    });

    it('detects Vue (.vue)', () => {
      expect(service.detectLanguage('src/components/App.vue')).toBe('vue');
    });

    it('detects SQL (.sql)', () => {
      expect(service.detectLanguage('db/schema.sql')).toBe('sql');
    });

    it('detects Terraform (.tf)', () => {
      expect(service.detectLanguage('infra/main.tf')).toBe('terraform');
    });

    it('detects Markdown (.md)', () => {
      expect(service.detectLanguage('docs/architecture.md')).toBe('markdown');
    });

    it('detects YAML (.yml)', () => {
      expect(service.detectLanguage('.github/workflows/ci.yml')).toBe('yaml');
    });

    it('returns unknown for unknown extension', () => {
      expect(service.detectLanguage('Makefile')).toBe('unknown');
    });
  });

  // ── Framework detection ───────────────────────────────────────────────────

  describe('detectFramework', () => {
    it('detects NestJS from package.json', () => {
      const files = ['package.json', 'src/app.module.ts'];
      const contents = new Map([['package.json', '{"dependencies": {"@nestjs/core": "^10.0.0"}}']]);
      expect(service.detectFramework(files, contents)).toBe('nestjs');
    });

    it('detects Next.js from next.config.js', () => {
      const files = ['next.config.js', 'package.json'];
      const contents = new Map([['package.json', '{}']]);
      expect(service.detectFramework(files, contents)).toBe('nextjs');
    });

    it('detects Next.js from next.config.ts', () => {
      const files = ['next.config.ts', 'package.json'];
      expect(service.detectFramework(files)).toBe('nextjs');
    });

    it('detects Vite+React from vite.config.ts without Vue plugin', () => {
      const files = ['vite.config.ts', 'package.json'];
      const contents = new Map([
        ['vite.config.ts', "import react from '@vitejs/plugin-react'; export default {}"],
        ['package.json', '{}'],
      ]);
      expect(service.detectFramework(files, contents)).toBe('vite-react');
    });

    it('detects Vite+Vue from vite.config.ts with Vue plugin', () => {
      const files = ['vite.config.ts', 'package.json'];
      const contents = new Map([
        ['vite.config.ts', "import vue from '@vitejs/plugin-vue'; export default {}"],
        ['package.json', '{}'],
      ]);
      expect(service.detectFramework(files, contents)).toBe('vite-vue');
    });

    it('detects Angular from angular.json', () => {
      const files = ['angular.json', 'package.json'];
      expect(service.detectFramework(files)).toBe('angular');
    });

    it('detects Svelte from svelte.config.js', () => {
      const files = ['svelte.config.js', 'package.json'];
      expect(service.detectFramework(files)).toBe('svelte');
    });

    it('detects FastAPI from requirements.txt', () => {
      const files = ['requirements.txt', 'main.py'];
      const contents = new Map([['requirements.txt', 'fastapi\nuvicorn\n']]);
      expect(service.detectFramework(files, contents)).toBe('fastapi');
    });

    it('detects Django from requirements.txt', () => {
      const files = ['requirements.txt', 'manage.py'];
      const contents = new Map([['requirements.txt', 'django\npsycopg2\n']]);
      expect(service.detectFramework(files, contents)).toBe('django');
    });

    it('detects Express from package.json', () => {
      const files = ['package.json', 'index.js'];
      const contents = new Map([['package.json', '{"dependencies": {"express": "^4.0.0"}}']]);
      expect(service.detectFramework(files, contents)).toBe('express');
    });

    it('returns unknown when no signals found', () => {
      expect(service.detectFramework(['src/main.go', 'go.mod'])).toBe('unknown');
    });
  });

  // ── Framework role detection ──────────────────────────────────────────────

  describe('getFrameworkRole', () => {
    describe('Next.js roles', () => {
      it('detects page', () => {
        expect(service.getFrameworkRole('src/app/dashboard/page.tsx', 'nextjs')).toBe('page');
      });
      it('detects layout', () => {
        expect(service.getFrameworkRole('src/app/layout.tsx', 'nextjs')).toBe('layout');
      });
      it('detects api-route', () => {
        expect(service.getFrameworkRole('src/app/api/users/route.ts', 'nextjs')).toBe('api-route');
      });
      it('detects middleware', () => {
        expect(service.getFrameworkRole('middleware.ts', 'nextjs')).toBe('middleware');
      });
      it('detects component', () => {
        expect(service.getFrameworkRole('src/components/Button.tsx', 'nextjs')).toBe('component');
      });
      it('detects hook', () => {
        expect(service.getFrameworkRole('src/hooks/useAuth.ts', 'nextjs')).toBe('hook');
      });
    });

    describe('Vite+React roles', () => {
      it('detects page', () => {
        expect(service.getFrameworkRole('src/pages/Home.tsx', 'vite-react')).toBe('page');
      });
      it('detects hook', () => {
        expect(service.getFrameworkRole('src/hooks/useData.ts', 'vite-react')).toBe('hook');
      });
      it('detects component', () => {
        expect(service.getFrameworkRole('src/Button.tsx', 'vite-react')).toBe('component');
      });
    });

    describe('Vite+Vue roles', () => {
      it('detects view', () => {
        expect(service.getFrameworkRole('src/views/Dashboard.vue', 'vite-vue')).toBe('view');
      });
      it('detects component', () => {
        expect(service.getFrameworkRole('src/components/Card.vue', 'vite-vue')).toBe('component');
      });
      it('detects composable', () => {
        expect(service.getFrameworkRole('src/composables/useAuth.ts', 'vite-vue')).toBe('composable');
      });
      it('detects store', () => {
        expect(service.getFrameworkRole('src/stores/user.ts', 'vite-vue')).toBe('store');
      });
    });

    describe('Angular roles', () => {
      it('detects component', () => {
        expect(service.getFrameworkRole('src/app/header.component.ts', 'angular')).toBe('component');
      });
      it('detects service', () => {
        expect(service.getFrameworkRole('src/app/auth.service.ts', 'angular')).toBe('service');
      });
      it('detects module', () => {
        expect(service.getFrameworkRole('src/app/app.module.ts', 'angular')).toBe('module');
      });
      it('detects guard', () => {
        expect(service.getFrameworkRole('src/app/auth.guard.ts', 'angular')).toBe('guard');
      });
    });

    describe('Svelte roles', () => {
      it('detects page', () => {
        expect(service.getFrameworkRole('src/routes/+page.svelte', 'svelte')).toBe('page');
      });
      it('detects layout', () => {
        expect(service.getFrameworkRole('src/routes/+layout.svelte', 'svelte')).toBe('layout');
      });
      it('detects api-route', () => {
        expect(service.getFrameworkRole('src/routes/api/+server.ts', 'svelte')).toBe('api-route');
      });
    });

    describe('Python/FastAPI roles', () => {
      it('detects model', () => {
        expect(service.getFrameworkRole('app/models.py', 'fastapi')).toBe('model');
      });
      it('detects router', () => {
        expect(service.getFrameworkRole('app/routers/users.py', 'fastapi')).toBe('router');
      });
      it('detects schema', () => {
        expect(service.getFrameworkRole('app/schemas.py', 'fastapi')).toBe('schema');
      });
    });

    it('returns null for unknown framework', () => {
      expect(service.getFrameworkRole('src/main.go', 'unknown')).toBeNull();
    });
  });
});
