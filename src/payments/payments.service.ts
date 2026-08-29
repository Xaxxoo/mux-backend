import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PrismaService } from '../prisma/prisma.service';
import { LimitsService } from '../limits/limits.service';
import { PaymentStatus } from './entities/payment.entity';
import { PaymentCreatedEvent } from './events/payment-created.event';
import { PaymentCompletedEvent } from './events/payment-completed.event';
import { PaymentFailedEvent } from './events/payment-failed.event';

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
    private readonly limitsService: LimitsService,
    private readonly walletsService: WalletsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(createPaymentDto: CreatePaymentDto) {
    const { walletId, receiverWalletId, fromId, toId, amount, currency, description } =
      createPaymentDto;

    // Validate sender wallet exists and is ACTIVE
    const senderWallet = await this.walletsService.findWalletById(walletId);
    if (senderWallet.status !== WalletStatus.ACTIVE) {
      throw new BadRequestException(
        `Sender wallet is not active (status: ${senderWallet.status})`,
      );
    }

    // Validate receiver wallet exists (status not enforced for receiver)
    await this.walletsService.findWalletById(receiverWalletId);

    // Scope limits check to the wallet owner (legacy userId)
    await this.limitsService.checkLimits(fromId, amount);

    const payment = await this.prisma.transaction.create({
      data: {
        fromId,
        toId,
        amount,
        currency,
        description,
        userId: fromId,
        status: 'PENDING',
      },
    });

    this.eventEmitter.emit(
      'payment.created',
      new PaymentCreatedEvent(payment.id, walletId, amount, currency, fromId),
    );

    return payment;
  }

  findAll() {
    return this.prisma.transaction.findMany();
  }

  findOne(id: string) {
    return this.prisma.transaction.findUnique({ where: { id } });
  }

  async update(id: number, updatePaymentDto: UpdatePaymentDto) {
    const payment = await this.prisma.payment.findUnique({ where: { id } });
    if (!payment) {
      throw new NotFoundException(`Payment #${id} not found`);
    }

    if (updatePaymentDto.status !== undefined) {
      const allowed = ALLOWED_TRANSITIONS[payment.status] ?? [];
      if (!allowed.includes(updatePaymentDto.status)) {
        throw new BadRequestException(
          `Cannot transition payment from ${payment.status} to ${updatePaymentDto.status}`,
        );
      }
    }

    const result = await this.prisma.payment.update({
      where: { id },
      data: updatePaymentDto,
    });

    if (updatePaymentDto.status === PaymentStatus.CONFIRMED) {
      this.eventEmitter.emit(
        'payment.completed',
        new PaymentCompletedEvent(
          String(id),
          payment.walletId ?? '',
          Number(payment.amount),
          payment.currency ?? '',
          payment.userId ?? '',
        ),
      );
    } else if (updatePaymentDto.status === PaymentStatus.FAILED) {
      this.eventEmitter.emit(
        'payment.failed',
        new PaymentFailedEvent(
          String(id),
          payment.walletId ?? '',
          Number(payment.amount),
          payment.currency ?? '',
          payment.userId ?? '',
          'Payment marked as failed',
        ),
      );
    }

    return result;
  }

  remove(id: string) {
    return `This action removes payment ${id}`;
  }
}
