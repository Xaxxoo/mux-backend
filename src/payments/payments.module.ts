import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { LimitsModule } from '../limits/limits.module';
import { WalletsModule } from '../wallets/wallets.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { PaymentWebhookListener } from './listeners/payment-webhook.listener';

@Module({
  imports: [LimitsModule, WalletsModule, WebhookModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaymentWebhookListener],
})
export class PaymentsModule {}
