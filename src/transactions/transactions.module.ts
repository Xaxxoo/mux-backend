import { Module } from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { StellarTransactionBuildService } from './stellar-transaction-build.service';
import { FeeBumpService } from './fee-bump.service';
import { PrismaModule } from '../prisma/prisma.module';
import { BalanceIndexerModule } from '../balance-indexer/balance-indexer.module';
import { WebhookModule } from '../webhooks/webhook.module';

@Module({
  imports: [PrismaModule, BalanceIndexerModule, WebhookModule],
  controllers: [TransactionsController],
  providers: [
    TransactionsService,
    StellarTransactionBuildService,
    FeeBumpService,
  ],
  exports: [TransactionsService, StellarTransactionBuildService, FeeBumpService],
})
export class TransactionsModule {}
