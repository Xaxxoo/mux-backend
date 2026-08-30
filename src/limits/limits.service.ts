import {
  Injectable,
  NotFoundException,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { CreateLimitDto, LimitPeriod } from './dto/create-limit.dto';
import { LimitUpdatedEvent } from './events/limit-updated.event';
import { LimitExceededEvent } from './events/limit-exceeded.event';
import { LimitsResponseDto } from './dto/limits-response.dto';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';

export const LIMIT_ERROR_CODES = {
  PER_TX_LIMIT_EXCEEDED: 'LIMIT_PER_TX_EXCEEDED',
  DAILY_LIMIT_EXCEEDED: 'LIMIT_DAILY_EXCEEDED',
} as const;

export type LimitErrorCode =
  (typeof LIMIT_ERROR_CODES)[keyof typeof LIMIT_ERROR_CODES];

export class LimitExceededException extends HttpException {
  constructor(
    public readonly errorCode: LimitErrorCode,
    message: string,
  ) {
    super({ errorCode, message }, HttpStatus.UNPROCESSABLE_ENTITY);
  }
}

@Injectable()
export class LimitsService {
  private readonly logger = new Logger(LimitsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
  ) {}

  async setLimits(walletId: string, daily: number, perTx: number) {
    const existing = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.findUnique({
          where: { walletId },
        }),
      3,
      100,
      this.logger,
    );

    const result = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.upsert({
          where: { walletId },
          update: {
            dailyLimit: daily,
            perTransactionLimit: perTx,
            deletedAt: null,
          },
          create: { walletId, dailyLimit: daily, perTransactionLimit: perTx },
        }),
      3,
      100,
      this.logger,
    );

    if (existing) {
      if (existing.dailyLimit !== daily) {
        this.eventEmitter.emit(
          'limit.updated',
          new LimitUpdatedEvent(
            walletId,
            'daily',
            existing.dailyLimit,
            daily,
            new Date(),
          ),
        );
      }
      if (existing.perTransactionLimit !== perTx) {
        this.eventEmitter.emit(
          'limit.updated',
          new LimitUpdatedEvent(
            walletId,
            'perTransaction',
            existing.perTransactionLimit,
            perTx,
            new Date(),
          ),
        );
      }
    } else {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(walletId, 'daily', null, daily, new Date()),
      );
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'perTransaction',
          null,
          perTx,
          new Date(),
        ),
      );
    }

    return result;
  }

  async getLimits(walletId: string): Promise<LimitsResponseDto | null> {
    const limit = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.findUnique({
          where: { walletId },
        }),
      3,
      100,
      this.logger,
    );

    if (!limit) {
      return null;
    }

    const response: LimitsResponseDto = {
      walletId: limit.walletId,
      dailyLimit: limit.dailyLimit,
      perTransactionLimit: limit.perTransactionLimit,
    };

    // Calculate remaining daily limit if a positive daily limit is configured
    if (limit.dailyLimit > 0) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      const txns = await retryWithBackoff(
        () =>
          this.prisma.transaction.findMany({
            where: { senderWalletId: walletId, createdAt: { gte: startOfDay } },
            select: { amount: true },
          }),
        3,
        100,
        this.logger,
      );

      const currentDailyTotal = txns.reduce(
        (sum, t) => sum + Number(t.amount),
        0,
      );
      response.remainingDailyLimit = Math.max(
        0,
        limit.dailyLimit - currentDailyTotal,
      );
    }

    return response;
  }

  async checkLimits(
    walletId: string,
    amount: number,
    assetCode?: string,
  ): Promise<void> {
    const limits = await this.getLimits(walletId);

    if (limits) {
      this.logger.log(`Checking limits walletId=${walletId} amount=${amount}`);

      // Enforce per-transaction cap: a cap of 0 blocks all transactions
      if (
        limits.perTransactionLimit >= 0 &&
        amount > limits.perTransactionLimit
      ) {
        this.eventEmitter.emit(
          'limit.exceeded',
          new LimitExceededEvent(
            walletId,
            'perTransaction',
            limits.perTransactionLimit,
            amount,
            new Date(),
          ),
        );
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.PER_TX_LIMIT_EXCEEDED,
          `Per-transaction limit exceeded. Limit: ${limits.perTransactionLimit}`,
        );
      }

      // Enforce daily cap only when a positive daily limit is configured
      if (limits.dailyLimit > 0) {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);

        const txns = await retryWithBackoff(
          () =>
            this.prisma.transaction.findMany({
              where: {
                senderWalletId: walletId,
                createdAt: { gte: startOfDay },
              },
              select: { amount: true },
            }),
          3,
          100,
          this.logger,
        );

        const currentDailyTotal = txns.reduce(
          (sum, t) => sum + Number(t.amount),
          0,
        );
        if (currentDailyTotal + amount > limits.dailyLimit) {
          this.metrics.incrementLimitExceeded('daily');
          this.metrics.incrementLimitChecks('denied');
          this.eventEmitter.emit(
            'limit.exceeded',
            new LimitExceededEvent(
              walletId,
              'daily',
              limits.dailyLimit,
              currentDailyTotal + amount,
              new Date(),
            ),
          );
          throw new LimitExceededException(
            LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
            `Daily limit exceeded. Limit: ${limits.dailyLimit}, Used: ${currentDailyTotal}`,
          );
        }
      }
    }

    // Enforce per-asset spending limits (SpendingLimit) in addition to wallet floats
    await this.enforceSpendingLimits(walletId, amount, assetCode);

    this.metrics.incrementLimitChecks('allowed');
  }

  /**
   * Enforces per-asset spending limits for the wallet's owner.
   * SpendingLimit rows are scoped by userId + assetCode (+ period), so native XLM
   * (assetCode null) and non-native assets such as USDC are accounted separately.
   */
  private async enforceSpendingLimits(
    walletId: string,
    amount: number,
    assetCode?: string,
  ): Promise<void> {
    const wallet = await retryWithBackoff(
      () =>
        this.prisma.wallet.findUnique({
          where: { id: walletId },
          select: { userId: true },
        }),
      3,
      100,
      this.logger,
    );

    if (!wallet) {
      return;
    }

    const spendingLimits = await retryWithBackoff(
      () =>
        this.prisma.spendingLimit.findMany({
          where: {
            userId: wallet.userId,
            isActive: true,
            OR: assetCode
              ? [{ assetCode }, { assetCode: null }]
              : [{ assetCode: null }],
          },
        }),
      3,
      100,
      this.logger,
    );

    for (const limit of spendingLimits) {
      const perTransactionLimit = Number(limit.perTransactionLimit);
      if (amount > perTransactionLimit) {
        this.metrics.incrementLimitExceeded('perTransaction');
        this.metrics.incrementLimitChecks('denied');
        this.eventEmitter.emit(
          'limit.exceeded',
          new LimitExceededEvent(
            walletId,
            'perTransaction',
            perTransactionLimit,
            amount,
            new Date(),
          ),
        );
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.PER_TX_LIMIT_EXCEEDED,
          `Per-transaction limit exceeded for asset. Limit: ${perTransactionLimit}`,
        );
      }

      const periodStart = this.getPeriodStart(limit.period as LimitPeriod);
      const txns = await retryWithBackoff(
        () =>
          this.prisma.transaction.findMany({
            where: {
              senderWalletId: walletId,
              createdAt: { gte: periodStart },
              ...(assetCode ? { assetCode } : {}),
            },
            select: { amount: true },
          }),
        3,
        100,
        this.logger,
      );

      const currentPeriodTotal = txns.reduce(
        (sum, t) => sum + Number(t.amount),
        0,
      );

      const periodLimit = Number(limit.periodLimit);
      if (currentPeriodTotal + amount > periodLimit) {
        this.metrics.incrementLimitExceeded('period');
        this.metrics.incrementLimitChecks('denied');
        this.eventEmitter.emit(
          'limit.exceeded',
          new LimitExceededEvent(
            walletId,
            'period',
            periodLimit,
            currentPeriodTotal + amount,
            new Date(),
          ),
        );
        throw new LimitExceededException(
          LIMIT_ERROR_CODES.DAILY_LIMIT_EXCEEDED,
          `Period limit exceeded for asset. Limit: ${periodLimit}, Used: ${currentPeriodTotal}`,
        );
      }
    }
  }

  /**
   * Returns the start of the current period for a given limit period.
   */
  private getPeriodStart(period: LimitPeriod): Date {
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    if (period === LimitPeriod.WEEKLY) {
      // Monday-based week
      const daysSinceMonday = (now.getDay() + 6) % 7;
      now.setDate(now.getDate() - daysSinceMonday);
    } else if (period === LimitPeriod.MONTHLY) {
      now.setDate(1);
    }

    return now;
  }

  /**
   * Creates or updates a per-asset spending limit for a user.
   * assetCode null applies the limit across all assets (e.g. native XLM).
   */
  async setSpendingLimit(dto: CreateLimitDto) {
    const period = dto.period ?? LimitPeriod.DAILY;
    const assetCode = dto.assetCode ?? null;

    const data = {
      perTransactionLimit: dto.perTransactionLimit,
      periodLimit: dto.periodLimit,
      isActive: dto.isActive ?? true,
    };

    const existing = await retryWithBackoff(
      () =>
        this.prisma.spendingLimit.findFirst({
          where: { userId: dto.userId, period, assetCode },
        }),
      3,
      100,
      this.logger,
    );

    const result = existing
      ? await this.prisma.spendingLimit.update({
          where: { id: existing.id },
          data,
        })
      : await this.prisma.spendingLimit.create({
          data: { ...data, userId: dto.userId, period, assetCode },
        });

    this.logger.log(
      `Set spending limit for user ${dto.userId} period=${period} asset=${assetCode ?? 'ALL'}`,
    );

    return result;
  }

  /**
   * Lists the per-asset spending limits configured for a user.
   */
  async getSpendingLimits(
    userId: string,
    filter?: { period?: LimitPeriod; isActive?: boolean },
  ) {
    return retryWithBackoff(
      () =>
        this.prisma.spendingLimit.findMany({
          where: {
            userId,
            ...(filter?.period ? { period: filter.period } : {}),
            ...(filter?.isActive !== undefined
              ? { isActive: filter.isActive }
              : {}),
          },
          orderBy: { createdAt: 'desc' },
        }),
      3,
      100,
      this.logger,
    );
  }

  /**
   * Deactivates a per-asset spending limit for a user (period + asset).
   */
  async removeSpendingLimit(
    userId: string,
    period: LimitPeriod,
    assetCode?: string,
  ) {
    return retryWithBackoff(
      () =>
        this.prisma.spendingLimit.updateMany({
          where: {
            userId,
            period,
            assetCode: assetCode ?? null,
          },
          data: { isActive: false },
        }),
      3,
      100,
      this.logger,
    );
  }

  async removeLimits(walletId: string) {
    const existing = await this.getLimits(walletId);
    if (!existing)
      throw new NotFoundException(`No limits found for wallet ${walletId}`);
    return retryWithBackoff(
      () =>
        this.prisma.walletLimit.update({
          where: { walletId },
          data: { deletedAt: new Date() },
        }),
      3,
      100,
      this.logger,
    );
  }

  async updateLimits(walletId: string, daily?: number, perTx?: number) {
    const existing = await this.getLimits(walletId);
    if (!existing)
      throw new NotFoundException(`No limits found for wallet ${walletId}`);

    if (daily === undefined && perTx === undefined) {
      return existing;
    }

    const updateData: {
      dailyLimit?: number;
      perTransactionLimit?: number;
    } = {};
    if (daily !== undefined) updateData.dailyLimit = daily;
    if (perTx !== undefined) updateData.perTransactionLimit = perTx;

    const result = await retryWithBackoff(
      () =>
        this.prisma.walletLimit.update({
          where: { walletId },
          data: updateData,
        }),
      3,
      100,
      this.logger,
    );

    if (daily !== undefined && existing.dailyLimit !== daily) {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'daily',
          existing.dailyLimit,
          daily,
          new Date(),
        ),
      );
    }
    if (perTx !== undefined && existing.perTransactionLimit !== perTx) {
      this.eventEmitter.emit(
        'limit.updated',
        new LimitUpdatedEvent(
          walletId,
          'perTransaction',
          existing.perTransactionLimit,
          perTx,
          new Date(),
        ),
      );
    }

    return result;
  }
}
