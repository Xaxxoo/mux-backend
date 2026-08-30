import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { PrismaClient } from '../generated/prisma/client';

// Mock Prisma
jest.mock('../generated/prisma/client', () => {
  return {
    PrismaClient: jest.fn(),
  };
});

describe('AuthRateLimitService', () => {
  let service: AuthRateLimitService;
  let configService: jest.Mocked<ConfigService>;
  let prismaMock: any;

  beforeEach(async () => {
    // Setup Prisma mock
    prismaMock = {
      rateLimitRecord: {
        findUnique: jest.fn(),
        deleteMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    (PrismaClient as jest.Mock).mockImplementation(() => prismaMock);

    // Setup ConfigService mock
    configService = {
      get: jest.fn((key: string, defaultValue: string) => {
        const config: Record<string, string> = {
          AUTH_RATE_LIMIT_MAX: '10',
          AUTH_RATE_LIMIT_WINDOW_MS: '60000',
        };
        return config[key] || defaultValue;
      }),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthRateLimitService,
        {
          provide: ConfigService,
          useValue: configService,
        },
      ],
    }).compile();

    service = module.get<AuthRateLimitService>(AuthRateLimitService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('checkRateLimit', () => {
    it('should allow request when within limit', async () => {
      const ipAddress = '192.168.1.1';

      prismaMock.rateLimitRecord.findUnique.mockResolvedValue(null);
      prismaMock.rateLimitRecord.create.mockResolvedValue({
        id: 'record-1',
        apiKeyId: `auth-rate-limit:${ipAddress}`,
        endpoint: 'POST /auth/authenticate',
        windowStart: new Date(),
        requestCount: 1,
      });

      const result = await service.checkRateLimit(ipAddress);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    it('should reject request when limit exceeded', async () => {
      const ipAddress = '192.168.1.1';
      const now = new Date();
      const windowStart = new Date(
        Math.floor(now.getTime() / 60000) * 60000,
      );

      prismaMock.rateLimitRecord.findUnique.mockResolvedValue({
        id: 'record-1',
        apiKeyId: `auth-rate-limit:${ipAddress}`,
        endpoint: 'POST /auth/authenticate',
        windowStart,
        requestCount: 10, // Already at limit
      });

      const result = await service.checkRateLimit(ipAddress);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.limit).toBe(10);
      expect(result.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('should increment request count for existing record', async () => {
      const ipAddress = '192.168.1.1';
      const now = new Date();
      const windowStart = new Date(
        Math.floor(now.getTime() / 60000) * 60000,
      );

      prismaMock.rateLimitRecord.findUnique.mockResolvedValue({
        id: 'record-1',
        apiKeyId: `auth-rate-limit:${ipAddress}`,
        endpoint: 'POST /auth/authenticate',
        windowStart,
        requestCount: 5,
      });

      prismaMock.rateLimitRecord.update.mockResolvedValue({
        id: 'record-1',
        apiKeyId: `auth-rate-limit:${ipAddress}`,
        endpoint: 'POST /auth/authenticate',
        windowStart,
        requestCount: 6,
      });

      const result = await service.checkRateLimit(ipAddress);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });

    it('should clean up old records for same IP', async () => {
      const ipAddress = '192.168.1.1';
      const now = new Date();
      const windowStart = new Date(
        Math.floor(now.getTime() / 60000) * 60000,
      );

      prismaMock.rateLimitRecord.findUnique.mockResolvedValue(null);
      prismaMock.rateLimitRecord.deleteMany.mockResolvedValue({ count: 3 });
      prismaMock.rateLimitRecord.create.mockResolvedValue({
        id: 'record-new',
        apiKeyId: `auth-rate-limit:${ipAddress}`,
        endpoint: 'POST /auth/authenticate',
        windowStart,
        requestCount: 1,
      });

      await service.checkRateLimit(ipAddress);

      expect(prismaMock.rateLimitRecord.deleteMany).toHaveBeenCalled();
      expect(prismaMock.rateLimitRecord.create).toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      const ipAddress = '192.168.1.1';

      prismaMock.rateLimitRecord.findUnique.mockRejectedValue(
        new Error('Database error'),
      );

      const result = await service.checkRateLimit(ipAddress);

      // Should fail open on error
      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(result.remaining).toBe(10);
    });
  });

  describe('getConfig', () => {
    it('should return rate limit configuration', () => {
      const config = service.getConfig();

      expect(config.maxRequests).toBe(10);
      expect(config.windowMs).toBe(60000);
    });
  });
});
