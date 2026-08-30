import { Module } from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { AdminRecoveryService } from './admin-recovery.service';
import { RecoveryController } from './recovery.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [RecoveryController],
  providers: [RecoveryService, AdminRecoveryService],
  exports: [RecoveryService, AdminRecoveryService],
})
export class RecoveryModule {}
