import { Module } from '@nestjs/common';
import { AuthOrchestrator } from './auth-orchestrator.service';
import { AuthOrchestratorController } from './auth-orchestrator.controller';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';
import { SessionService } from './session.service';
import { IdempotentUserModule } from '../users/idempotent-user.module';
import { WalletsModule } from '../wallets/wallets.module';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

@Module({
  imports: [IdempotentUserModule, WalletsModule],
  controllers: [AuthOrchestratorController],
  providers: [
    AuthOrchestrator,
    SessionService,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
  ],
  exports: [
    AuthOrchestrator,
    SessionService,
    IdempotencyService,
    AuthRateLimitService,
    AuthRateLimitGuard,
  ],
})
export class AuthModule {}
