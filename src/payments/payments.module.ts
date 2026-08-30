import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { LimitsModule } from '../limits/limits.module';
import { LimitsService } from '../limits/limits.service';
import { WalletsModule } from '../wallets/wallets.module';
import { WebhookModule } from '../webhooks/webhook.module';
import { PAYMENT_LIMITS_PORT } from './ports/payment-limits.port';
import { RequestContextService } from '../common/request-context/request-context.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { FeatureFlagGuard } from '../common/feature-flags/feature-flag.guard';

@Module({
  imports: [ConfigModule, LimitsModule, WalletsModule, WebhookModule],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    { provide: PAYMENT_LIMITS_PORT, useExisting: LimitsService },
    RequestContextService,
    FeatureFlagService,
    FeatureFlagGuard,
  ],
})
export class PaymentsModule {}
