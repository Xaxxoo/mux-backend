import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionStatus } from '../generated/prisma';

export interface CreateSessionRequest {
  userId: string;
  sessionToken: string;
  expiresAt: Date;
}

export interface RevokeSessionRequest {
  sessionToken: string;
  reason?: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(private readonly prisma: PrismaService) {}

  async createSession(request: CreateSessionRequest) {
    this.logger.log(`Creating session for user ${request.userId}`);
    return this.prisma.session.create({
      data: {
        userId: request.userId,
        sessionToken: request.sessionToken,
        expiresAt: request.expiresAt,
        status: SessionStatus.ACTIVE,
      },
    });
  }

  async revokeSession(request: RevokeSessionRequest) {
    this.logger.log(`Revoking session: ${request.sessionToken}`);
    return this.prisma.session.update({
      where: { sessionToken: request.sessionToken },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
        revokeReason: request.reason || 'User initiated revocation',
      },
    });
  }

  async revokeUserSessions(userId: string, reason?: string) {
    this.logger.log(`Revoking all sessions for user ${userId}`);
    return this.prisma.session.updateMany({
      where: {
        userId,
        status: SessionStatus.ACTIVE,
      },
      data: {
        status: SessionStatus.REVOKED,
        revokedAt: new Date(),
        revokeReason: reason || 'Sessions revoked on credential change',
      },
    });
  }

  async getActiveSessions(userId: string) {
    return this.prisma.session.findMany({
      where: {
        userId,
        status: SessionStatus.ACTIVE,
        expiresAt: { gt: new Date() },
      },
    });
  }

  async validateSession(sessionToken: string) {
    const session = await this.prisma.session.findUnique({
      where: { sessionToken },
    });

    if (!session) return null;
    if (session.status !== SessionStatus.ACTIVE) return null;
    if (session.expiresAt < new Date()) return null;

    return session;
  }
}
