import { Module } from '@nestjs/common';
import { LimitsService } from './limits.service';
import { LimitsController } from './limits.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { WebhookModule } from '../webhooks/webhook.module';

@Module({
  imports: [PrismaModule, WebhookModule],
  controllers: [LimitsController],
  providers: [LimitsService],
  exports: [LimitsService],
})
export class LimitsModule {}
