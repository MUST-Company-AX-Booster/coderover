import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { GitHubService } from './github.service';
import * as crypto from 'crypto';

describe('GitHubService', () => {
  let service: GitHubService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GitHubService,
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('test-token') },
        },
      ],
    }).compile();

    service = module.get<GitHubService>(GitHubService);
  });

  describe('parseRepo', () => {
    it('should parse owner/repo correctly', () => {
      const result = (service as any).parseRepo('demo/codebase');
      expect(result.owner).toBe('demo');
      expect(result.repo).toBe('codebase');
    });
  });

  describe('verifyWebhookSignature', () => {
    it('should return true for a valid signature', () => {
      const secret = 'my-webhook-secret';
      const payload = Buffer.from(JSON.stringify({ action: 'push' }));
      const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      const signature = `sha256=${hmac}`;

      expect(service.verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('should return false for an invalid signature', () => {
      const payload = Buffer.from('{"action":"push"}');
      expect(service.verifyWebhookSignature(payload, 'sha256=invalid', 'secret')).toBe(false);
    });

    it('should return false when signature length differs (timing safe)', () => {
      const payload = Buffer.from('{"action":"push"}');
      expect(service.verifyWebhookSignature(payload, 'sha256=abc', 'secret')).toBe(false);
    });
  });

  describe('getOctokit', () => {
    it('should create an Octokit instance with given token', () => {
      const octokit = service.getOctokit('custom-token');
      expect(octokit).toBeDefined();
    });

    it('should fall back to GITHUB_TOKEN from config', () => {
      const octokit = service.getOctokit();
      expect(octokit).toBeDefined();
    });
  });
});
