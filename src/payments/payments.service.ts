import {
  Inject,
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UpdatePaymentDto } from './dto/update-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { WalletsService } from '../wallets/wallets.service';
import {
  PAYMENT_LIMITS_PORT,
  PaymentLimitsPort,
} from './ports/payment-limits.port';
import { WalletStatus } from '../wallets/domain/wallet.model';
import { PaymentStatus } from './entities/payment.entity';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';
import { PaymentsFilterDto } from './dto/payments-filter.dto';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';
import { retryWithBackoff } from '../common/utils/retry';
import { MetricsService } from '../metrics/metrics.service';
import { RequestContextService } from '../common/request-context/request-context.service';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';

// Only PENDING payments can be transitioned; terminal states are immutable.
const ALLOWED_TRANSITIONS: Record<string, PaymentStatus[]> = {
  [PaymentStatus.PENDING]: [PaymentStatus.CONFIRMED, PaymentStatus.FAILED],
  [PaymentStatus.CONFIRMED]: [],
  [PaymentStatus.FAILED]: [],
};

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_LIMITS_PORT)
    private readonly paymentLimitsPort: PaymentLimitsPort,
    private readonly walletsService: WalletsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly webhookEventEmitter: WebhookEventEmitterService,
  ) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const {
      walletId,
      receiverWalletId,
      fromId,
      toId,
      amount,
      currency,
      assetCode,
      description,
      idempotencyKey,
    } = createPaymentDto;

    if (idempotencyKey) {
      const existing = await this.prisma.payment.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.log(
          `Idempotency hit for key ${idempotencyKey}, returning existing payment ${existing.id} requestId=${requestId}`,
        );
        this.metrics.incrementPaymentIdempotencyHit();
        return existing;
      }
    }

    const senderWallet = await retryWithBackoff(
      () => this.walletsService.findWalletById(walletId),
      3,
      100,
      this.logger,
    );
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    await retryWithBackoff(
      () => this.walletsService.findWalletById(receiverWalletId),
      3,
      100,
      this.logger,
    );
    await retryWithBackoff(
      () => this.paymentLimitsPort.checkLimits(walletId, amount, assetCode),
      3,
      100,
      this.logger,
    );

    const payment = await this.prisma.payment.create({
      data: {
        fromId,
        toId,
        amount,
        currency,
        assetCode,
        description,
        userId: fromId,
        status: PaymentStatus.PENDING,
        idempotencyKey: idempotencyKey ?? null,
      },
    });

    this.metrics.incrementPaymentsCreated();

    this.eventEmitter.emit(
      'payment.created',
      new PaymentCreatedEvent(
        payment.id,
        payment.amount,
        payment.currency,
        payment.userId,
        new Date(),
      ),
    );

    await this.webhookEventEmitter.emitPaymentCreated({
      paymentId: payment.id,
      amount: payment.amount,
      currency: payment.currency,
      assetCode: payment.assetCode ?? null,
      userId: payment.userId,
      status: payment.status,
    });

    return payment;
  }

  async findAll(
    pagination: PaginationDto,
    filters: PaymentsFilterDto,
  ): Promise<PaginatedResponse<any>> {
    const skip = (pagination.page - 1) * pagination.limit;

    const where: any = {};
    if (filters.status) {
      where.status = filters.status;
    }

    const [data, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        skip,
        take: pagination.limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data,
      total,
      page: pagination.page,
      limit: pagination.limit,
    };
  }

  findOne(id: string) {
    return this.prisma.payment.findUnique({
      where: { id: parseInt(id, 10) },
    });
  }

  async update(id: string, updatePaymentDto: UpdatePaymentDto) {
    const requestId = this.requestContext.getRequestId();
    const paymentId = parseInt(id, 10);

    this.logger.log(
      `Updating payment id=${paymentId} requestId=${requestId}`,
    );

    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) {
      throw new NotFoundException(`Payment #${paymentId} not found`);
    }

    if (updatePaymentDto.status !== undefined) {
      const allowed = ALLOWED_TRANSITIONS[payment.status] ?? [];
      if (!allowed.includes(updatePaymentDto.status)) {
        throw new BadRequestException(
          `Cannot transition payment from ${payment.status} to ${updatePaymentDto.status}`,
        );
      }
    }

    const updatedPayment = await this.prisma.payment.update({
      where: { id: paymentId },
      data: updatePaymentDto,
    });

    if (updatePaymentDto.status === PaymentStatus.CONFIRMED) {
      this.eventEmitter.emit(
        'payment.completed',
        new PaymentCompletedEvent(
          updatedPayment.id,
          updatedPayment.amount,
          updatedPayment.currency,
          updatedPayment.userId,
          new Date(),
        ),
      );

      await this.webhookEventEmitter.emitPaymentCompleted({
        paymentId: updatedPayment.id,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        assetCode: updatedPayment.assetCode ?? null,
        userId: updatedPayment.userId,
        status: updatedPayment.status,
      });
    } else if (updatePaymentDto.status === PaymentStatus.FAILED) {
      this.metrics.incrementPaymentsFailed('user_action');
      this.eventEmitter.emit(
        'payment.failed',
        new PaymentFailedEvent(
          updatedPayment.id,
          updatedPayment.amount,
          updatedPayment.currency,
          updatedPayment.userId,
          new Date(),
        ),
      );

      await this.webhookEventEmitter.emitPaymentFailed({
        paymentId: updatedPayment.id,
        amount: updatedPayment.amount,
        currency: updatedPayment.currency,
        assetCode: updatedPayment.assetCode ?? null,
        userId: updatedPayment.userId,
        status: updatedPayment.status,
      });
    }

    return updatedPayment;
  }

  remove(id: string) {
    return `This action removes payment ${id}`;
  }
}
