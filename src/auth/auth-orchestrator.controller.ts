import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Headers,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  AuthOrchestrator,
  AuthenticationRequest,
  AuthenticationResult,
  AuthenticationRequestWithIdempotency,
} from './auth-orchestrator.service';
import { SessionService } from './session.service';
import { Public } from './public.decorator';
import { AuthRateLimitGuard } from './auth-rate-limit.guard';

@Controller('auth')
export class AuthOrchestratorController {
  constructor(
    private readonly authOrchestrator: AuthOrchestrator,
    private readonly sessionService: SessionService,
  ) {}

  /**
   * Main authentication endpoint - handles both first-time and returning users
   *
   * This endpoint:
   * 1. Creates user if first time
   * 2. Creates wallet if first time
   * 3. Returns existing user + wallet if already exists
   *
   * All operations are idempotent.
   * Supports optional Idempotency-Key header for request deduplication.
   * Protected by per-IP rate limiting to prevent brute force attacks.
   */
  @Post('authenticate')
  @UseGuards(AuthRateLimitGuard)
  @HttpCode(HttpStatus.OK)
  async authenticate(
    @Body() request: AuthenticationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const requestWithIdempotency: AuthenticationRequestWithIdempotency = {
      ...request,
      idempotencyKey,
    };

    const result = await this.authOrchestrator.handleAuthentication(
      requestWithIdempotency,
    );

    // Extract and remove metadata before sending response
    const idempotencyReplayed = (result as any)._idempotencyReplayed ?? false;
    const responseBody = { ...result };
    delete (responseBody as any)._idempotencyReplayed;

    // Set idempotency-replayed header if idempotency key was provided
    if (idempotencyKey) {
      response.setHeader(
        'Idempotency-Replayed',
        idempotencyReplayed ? 'true' : 'false',
      );
    }

    response.json(responseBody);
  }

  /**
   * Validation endpoint - checks if authentication is possible
   */
  @Get('validate/:authId')
  async validateAuthentication(@Param('authId') authId: string) {
    return { valid: true };
  }

  /**
   * Revoke a specific session
   */
  @Post('sessions/revoke')
  @HttpCode(HttpStatus.OK)
  async revokeSession(
    @Body() request: { sessionToken: string; reason?: string },
  ) {
    const result = await this.sessionService.revokeSession({
      sessionToken: request.sessionToken,
      reason: request.reason,
    });
    return { success: true, revokedAt: result.revokedAt };
  }

  /**
   * Revoke all sessions for a user (on credential change)
   */
  @Post('sessions/revoke-all/:userId')
  @HttpCode(HttpStatus.OK)
  async revokeUserSessions(
    @Param('userId') userId: string,
    @Body() request?: { reason?: string },
  ) {
    const result = await this.sessionService.revokeUserSessions(
      userId,
      request?.reason,
    );
    return {
      success: true,
      revokedCount: result.count,
    };
  }

  /**
   * Get active sessions for a user
   */
  @Get('sessions/:userId')
  async getActiveSessions(@Param('userId') userId: string) {
    const sessions = await this.sessionService.getActiveSessions(userId);
    return { sessions };
  }
}
