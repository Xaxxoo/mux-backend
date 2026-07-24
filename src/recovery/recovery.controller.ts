import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { RecoveryService } from './recovery.service';
import { AdminRecoveryService } from './admin-recovery.service';
import { CreateRecoveryDto } from './dto/create-recovery.dto';
import { UpdateRecoveryDto } from './dto/update-recovery.dto';

@Controller('recovery')
export class RecoveryController {
  constructor(
    private readonly recoveryService: RecoveryService,
    private readonly adminRecoveryService: AdminRecoveryService,
  ) {}

  @Post()
  create(@Body() createRecoveryDto: CreateRecoveryDto) {
    return this.recoveryService.create(createRecoveryDto);
  }

  @Get()
  findAll() {
    return this.recoveryService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.recoveryService.findOne(id);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() updateRecoveryDto: UpdateRecoveryDto,
  ) {
    return this.recoveryService.update(id, updateRecoveryDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.recoveryService.remove(id);
  }

  /**
   * Admin endpoint: Approve a recovery request
   */
  @Post('admin/approve/:id')
  @HttpCode(HttpStatus.OK)
  async approveRecovery(
    @Param('id') recoveryId: string,
    @Body() request: { adminId: string; approvalNotes?: string },
  ) {
    return this.adminRecoveryService.approveRecovery({
      recoveryId,
      adminId: request.adminId,
      approvalNotes: request.approvalNotes,
    });
  }

  /**
   * Admin endpoint: Reject a recovery request
   */
  @Post('admin/reject/:id')
  @HttpCode(HttpStatus.OK)
  async rejectRecovery(
    @Param('id') recoveryId: string,
    @Body() request: { adminId: string; rejectionReason: string },
  ) {
    return this.adminRecoveryService.rejectRecovery({
      recoveryId,
      adminId: request.adminId,
      rejectionReason: request.rejectionReason,
    });
  }

  /**
   * Admin endpoint: Get all pending recovery requests
   */
  @Get('admin/pending')
  async getPendingRecoveries() {
    return this.adminRecoveryService.getPendingRecoveries();
  }

  /**
   * Admin endpoint: Get recovery request history
   */
  @Get('admin/history/:id')
  async getRecoveryHistory(@Param('id') recoveryId: string) {
    return this.adminRecoveryService.getRecoveryHistory(recoveryId);
  }
}
