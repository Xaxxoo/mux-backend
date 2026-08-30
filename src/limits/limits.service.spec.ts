import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { LimitsService, LimitExceededException } from './limits.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { LimitUpdatedEvent } from './events/limit-updated.event';
import { LimitExceededEvent } from './events/limit-exceeded.event';

describe('LimitsService', () => {
  let service: LimitsService;
  let prisma: any;
  let eventEmitter: any;
  let metrics: any;
  let requestContext: any;

  const walletId = 'wallet-uuid-1';

  beforeEach(async () => {
    prisma = {
      walletLimit: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
        delete: jest.fn(),
      },
      transaction: {
        findMany: jest.fn(),
      },
      wallet: {
        findUnique: jest.fn().mockResolvedValue({ userId: 1 }),
      },
      spendingLimit: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    eventEmitter = { emit: jest.fn() };
    metrics = {
      incrementLimitExceeded: jest.fn(),
      incrementLimitChecks: jest.fn(),
    };
    requestContext = { getRequestId: jest.fn().mockReturnValue('req-1') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LimitsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: eventEmitter },
        { provide: MetricsService, useValue: metrics },
        { provide: RequestContextService, useValue: requestContext },
      ],
    }).compile();

    service = module.get<LimitsService>(LimitsService);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('setLimits', () => {
    it('should upsert wallet limits', async () => {
      await service.setLimits(walletId, 100, 10);
      expect(prisma.walletLimit.upsert).toHaveBeenCalledWith({
        where: { walletId },
        update: { dailyLimit: 100, perTransactionLimit: 10 },
        create: { walletId, dailyLimit: 100, perTransactionLimit: 10 },
      });
    });
  });

  describe('getLimits', () => {
    it('should return limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      const result = await service.getLimits(walletId);
      expect(result).toEqual(limit);
    });

    it('should use the cache layer for wallet limits', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      cacheService.get.mockReturnValue(limit);

      const result = await service.getLimits(walletId);

      expect(result).toEqual(limit);
      expect(cacheService.get).toHaveBeenCalledWith(`limits:${walletId}`);
      expect(prisma.walletLimit.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('checkLimits', () => {
    it('should pass if no limits set', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.checkLimits(walletId, 100)).resolves.not.toThrow();
    });

    it('should throw if per-transaction limit exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 50,
        dailyLimit: 1000,
      });
      await expect(service.checkLimits(walletId, 100)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should throw if daily limit exceeded', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);
      await expect(service.checkLimits(walletId, 60)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should pass if within limits', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(service.checkLimits(walletId, 50)).resolves.not.toThrow();
    });

    it('should pass when the cumulative daily total lands exactly on the limit', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(service.checkLimits(walletId, 60)).resolves.not.toThrow();
    });

    it('should throw as soon as the cumulative daily total exceeds the limit by any amount', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([{ amount: '40' }]);
      await expect(
        service.checkLimits(walletId, 60.01),
      ).rejects.toBeInstanceOf(LimitExceededException);
    });

    it('should sum multiple transactions from today toward the daily total', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 200,
        dailyLimit: 100,
      });
      prisma.transaction.findMany.mockResolvedValue([
        { amount: '30' },
        { amount: '20' },
      ]);
      await expect(service.checkLimits(walletId, 51)).rejects.toBeInstanceOf(
        LimitExceededException,
      );
    });

    it('should not enforce a daily cap when dailyLimit is 0 (unset/unlimited)', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue({
        perTransactionLimit: 1000,
        dailyLimit: 0,
      });
      await expect(
        service.checkLimits(walletId, 999),
      ).resolves.not.toThrow();
      expect(prisma.transaction.findMany).not.toHaveBeenCalled();
    });
  });

  describe('removeLimits', () => {
    it('should delete limits for a wallet', async () => {
      const limit = { walletId, dailyLimit: 100, perTransactionLimit: 10 };
      prisma.walletLimit.findUnique.mockResolvedValue(limit);
      prisma.walletLimit.delete.mockResolvedValue(limit);
      await service.removeLimits(walletId);
      expect(prisma.walletLimit.delete).toHaveBeenCalledWith({
        where: { walletId },
      });
    });

    it('should throw NotFoundException if no limits exist', async () => {
      prisma.walletLimit.findUnique.mockResolvedValue(null);
      await expect(service.removeLimits(walletId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('domain events', () => {
    describe('limit.exceeded', () => {
      it('should emit limit.exceeded when per-transaction limit is exceeded', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          perTransactionLimit: 50,
          dailyLimit: 1000,
        });

        try {
          await service.checkLimits(walletId, 100);
        } catch (e) {
          // Expected to throw
        }

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.exceeded',
          expect.any(LimitExceededEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.userId).toBe(walletId);
        expect(emittedEvent.limitType).toBe('perTransaction');
        expect(emittedEvent.limit).toBe(50);
        expect(emittedEvent.attempted).toBe(100);
      });

      it('should emit limit.exceeded when daily limit is exceeded', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          perTransactionLimit: 200,
          dailyLimit: 100,
        });
        prisma.transaction.findMany.mockResolvedValue([{ amount: '50' }]);

        try {
          await service.checkLimits(walletId, 60);
        } catch (e) {
          // Expected to throw
        }

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.exceeded',
          expect.any(LimitExceededEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.userId).toBe(walletId);
        expect(emittedEvent.limitType).toBe('daily');
        expect(emittedEvent.limit).toBe(100);
        expect(emittedEvent.attempted).toBe(110);
      });
    });

    describe('limit.updated', () => {
      it('should emit limit.updated events when creating new limits', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue(null);
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });

        await service.setLimits(walletId, 100, 10);

        expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
      });

      it('should emit limit.updated when modifying daily limit', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 200,
          perTransactionLimit: 10,
        });

        await service.setLimits(walletId, 200, 10);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.limitType).toBe('daily');
        expect(emittedEvent.oldValue).toBe(100);
        expect(emittedEvent.newValue).toBe(200);
      });

      it('should emit limit.updated when modifying per-transaction limit', async () => {
        prisma.walletLimit.findUnique.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 10,
        });
        prisma.walletLimit.upsert.mockResolvedValue({
          walletId,
          dailyLimit: 100,
          perTransactionLimit: 20,
        });

        await service.setLimits(walletId, 100, 20);

        expect(eventEmitter.emit).toHaveBeenCalledWith(
          'limit.updated',
          expect.any(LimitUpdatedEvent),
        );
        const emittedEvent = eventEmitter.emit.mock.calls[0][1];
        expect(emittedEvent.limitType).toBe('perTransaction');
        expect(emittedEvent.oldValue).toBe(10);
        expect(emittedEvent.newValue).toBe(20);
      });
    });
  });
});
