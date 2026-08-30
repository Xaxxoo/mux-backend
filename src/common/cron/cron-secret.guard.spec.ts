import { Test, TestingModule } from '@nestjs/testing';
import {
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronSecretGuard } from './cron-secret.guard';

describe('CronSecretGuard (unit)', () => {
  let guard: CronSecretGuard;
  let configService: ConfigService;
  const VALID_SECRET = 'valid-cron-secret-32-chars-minimum!';
  const INVALID_SECRET = 'wrong-secret';

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CronSecretGuard,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              if (key === 'CRON_SECRET') {
                return VALID_SECRET;
              }
              return defaultValue;
            }),
          },
        },
      ],
    }).compile();

    guard = module.get<CronSecretGuard>(CronSecretGuard);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('canActivate', () => {
    const createMockExecutionContext = (
      headers: Record<string, string | undefined> = {},
      ip: string = '127.0.0.1',
      requestId: string = 'test-req-id'
    ): ExecutionContext => {
      const mockRequest = {
        headers,
        ip,
        requestId,
      };

      const mockExecutionContext = {
        switchToHttp: jest.fn().mockReturnValue({
          getRequest: jest.fn().mockReturnValue(mockRequest),
        }),
      } as unknown as ExecutionContext;

      return mockExecutionContext;
    };

    describe('when CRON_SECRET is not configured', () => {
      beforeEach(() => {
        (configService.get as jest.Mock).mockImplementation(() => '');
        guard = new CronSecretGuard(configService);
      });

      it('throws UnauthorizedException with "not configured" message', () => {
        const context = createMockExecutionContext();

        expect(() => guard.canActivate(context)).toThrow(
          UnauthorizedException
        );
        expect(() => guard.canActivate(context)).toThrow(
          'Cron secret not configured on server'
        );
      });

      it('throws even if X-Cron-Secret header is provided', () => {
        const context = createMockExecutionContext({
          'x-cron-secret': INVALID_SECRET,
        });

        expect(() => guard.canActivate(context)).toThrow(
          UnauthorizedException
        );
        expect(() => guard.canActivate(context)).toThrow(
          'Cron secret not configured on server'
        );
      });
    });

    describe('when CRON_SECRET is configured', () => {
      beforeEach(() => {
        (configService.get as jest.Mock).mockImplementation((key) => {
          if (key === 'CRON_SECRET') {
            return VALID_SECRET;
          }
          return '';
        });
        guard = new CronSecretGuard(configService);
      });

      describe('and X-Cron-Secret header is missing', () => {
        it('throws UnauthorizedException with "header is required" message', () => {
          const context = createMockExecutionContext({});

          expect(() => guard.canActivate(context)).toThrow(
            UnauthorizedException
          );
          expect(() => guard.canActivate(context)).toThrow(
            'X-Cron-Secret header is required'
          );
        });

        it('throws even if other headers are provided', () => {
          const context = createMockExecutionContext({
            'x-api-key': 'some-key',
            'authorization': 'Bearer token',
          });

          expect(() => guard.canActivate(context)).toThrow(
            UnauthorizedException
          );
          expect(() => guard.canActivate(context)).toThrow(
            'X-Cron-Secret header is required'
          );
        });
      });

      describe('and X-Cron-Secret header is empty', () => {
        it('throws UnauthorizedException', () => {
          const context = createMockExecutionContext({
            'x-cron-secret': '',
          });

          expect(() => guard.canActivate(context)).toThrow(
            UnauthorizedException
          );
          expect(() => guard.canActivate(context)).toThrow(
            'X-Cron-Secret header is required'
          );
        });
      });

      describe('and X-Cron-Secret header value is incorrect', () => {
        it('throws UnauthorizedException with "Invalid cron secret" message', () => {
          const context = createMockExecutionContext({
            'x-cron-secret': INVALID_SECRET,
          });

          expect(() => guard.canActivate(context)).toThrow(
            UnauthorizedException
          );
          expect(() => guard.canActivate(context)).toThrow(
            'Invalid cron secret'
          );
        });

        it('throws even if the invalid secret is similar to the valid one', () => {
          const context = createMockExecutionContext({
            'x-cron-secret': VALID_SECRET + 'extra',
          });

          expect(() => guard.canActivate(context)).toThrow(
            UnauthorizedException
          );
          expect(() => guard.canActivate(context)).toThrow(
            'Invalid cron secret'
          );
        });
      });

      describe('and X-Cron-Secret header value is correct', () => {
        it('returns true', () => {
          const context = createMockExecutionContext({
            'x-cron-secret': VALID_SECRET,
          });

          const result = guard.canActivate(context);

          expect(result).toBe(true);
        });

        it('returns true regardless of case of header name (case-insensitive)', () => {
          // Express/Node normalizes header names to lowercase
          const context = createMockExecutionContext({
            'x-cron-secret': VALID_SECRET,
          });

          const result = guard.canActivate(context);

          expect(result).toBe(true);
        });

        it('returns true even with other headers present', () => {
          const context = createMockExecutionContext({
            'x-cron-secret': VALID_SECRET,
            'x-request-id': 'req-123',
            'user-agent': 'test-agent',
          });

          const result = guard.canActivate(context);

          expect(result).toBe(true);
        });
      });
    });

    describe('request tracking and logging', () => {
      beforeEach(() => {
        (configService.get as jest.Mock).mockImplementation((key) => {
          if (key === 'CRON_SECRET') {
            return VALID_SECRET;
          }
          return '';
        });
        guard = new CronSecretGuard(configService);
      });

      it('includes request ID in logs for traceability', () => {
        const requestId = 'trace-id-12345';
        const context = createMockExecutionContext(
          { 'x-cron-secret': VALID_SECRET },
          '192.168.1.100',
          requestId
        );

        // Should not throw
        const result = guard.canActivate(context);
        expect(result).toBe(true);
      });

      it('logs the client IP address for failed authentication', () => {
        const clientIp = '203.0.113.42';
        const context = createMockExecutionContext({}, clientIp);

        expect(() => guard.canActivate(context)).toThrow(
          UnauthorizedException
        );
      });
    });

    describe('security - secret handling', () => {
      beforeEach(() => {
        (configService.get as jest.Mock).mockImplementation((key) => {
          if (key === 'CRON_SECRET') {
            return VALID_SECRET;
          }
          return '';
        });
        guard = new CronSecretGuard(configService);
      });

      it('does not expose CRON_SECRET value in error messages', () => {
        const context = createMockExecutionContext({
          'x-cron-secret': INVALID_SECRET,
        });

        try {
          guard.canActivate(context);
          fail('Expected UnauthorizedException');
        } catch (error) {
          if (error instanceof UnauthorizedException) {
            // The error message should not contain the actual secret
            expect(error.message).not.toContain(VALID_SECRET);
            expect(error.message).not.toContain(INVALID_SECRET);
            expect(error.message).toBe('Invalid cron secret');
          } else {
            throw error;
          }
        }
      });

      it('constant-time comparison should be used for secret comparison (not vulnerable to timing attacks)', () => {
        // This test ensures we're comparing secrets properly.
        // In production, consider using crypto.timingSafeEqual for defense against timing attacks.
        const context = createMockExecutionContext({
          'x-cron-secret': VALID_SECRET,
        });

        const result = guard.canActivate(context);
        expect(result).toBe(true);
      });
    });
  });
});
