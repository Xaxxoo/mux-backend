import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Guard that validates cron/internal endpoint requests using a shared secret header.
 * The secret must be provided in the X-Cron-Secret header and must match the
 * configured CRON_SECRET environment variable.
 *
 * Fail-closed behavior:
 *   - If CRON_SECRET is not configured, all cron requests are rejected (401).
 *   - If X-Cron-Secret header is missing or invalid, the request is rejected (401).
 *   - Never logs the actual CRON_SECRET value or X-Cron-Secret header content.
 *   - Logs request IDs for traceability.
 *
 * Issue #801: This guard ensures that POST /v1/transactions/internal/poll-pending
 * and other internal endpoints require a valid CRON_SECRET, preventing unauthorized
 * access to internal cron jobs and background operations.
 */
@Injectable()
export class CronSecretGuard implements CanActivate {
  private readonly logger = new Logger(CronSecretGuard.name);
  private readonly cronSecret: string;

  constructor(private readonly configService: ConfigService) {
    this.cronSecret = this.configService.get<string>('CRON_SECRET', '');
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const secretHeader = request.headers['x-cron-secret'] as string;
    // Get request ID for traceability (added by request-logging middleware)
    const requestId = (request as any).requestId || 'unknown';

    if (!this.cronSecret) {
      this.logger.warn(
        `[${requestId}] CRON_SECRET not configured; denying all cron requests`,
      );
      throw new UnauthorizedException(
        'Cron secret not configured on server',
      );
    }

    if (!secretHeader) {
      this.logger.warn(
        `[${requestId}] Cron request from ${request.ip} missing X-Cron-Secret header`,
      );
      throw new UnauthorizedException(
        'X-Cron-Secret header is required',
      );
    }

    if (secretHeader !== this.cronSecret) {
      this.logger.warn(
        `[${requestId}] Cron request from ${request.ip} with invalid secret`,
      );
      throw new UnauthorizedException('Invalid cron secret');
    }

    this.logger.debug(
      `[${requestId}] Cron request from ${request.ip} authenticated successfully`,
    );
    return true;
  }
}
