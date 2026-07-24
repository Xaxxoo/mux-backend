import { Test, TestingModule } from '@nestjs/testing';
import { SessionService } from './session.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { SessionStatus } from '../generated/prisma';

describe('SessionService', () => {
  let service: SessionService;
  let prismaMock: any;

  beforeEach(async () => {
    prismaMock = {
      session: {
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: PrismaService, useValue: prismaMock },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  describe('createSession', () => {
    it('should create a new session', async () => {
      const request = {
        userId: 'user-1',
        sessionToken: 'token-1',
        expiresAt: new Date(Date.now() + 3600000),
      };

      prismaMock.session.create.mockResolvedValue({
        ...request,
        status: SessionStatus.ACTIVE,
        id: 'session-1',
      });

      const result = await service.createSession(request);
      expect(result.status).toBe(SessionStatus.ACTIVE);
      expect(prismaMock.session.create).toHaveBeenCalled();
    });
  });

  describe('revokeSession', () => {
    it('should revoke a session', async () => {
      const sessionToken = 'token-1';
      const revokedAt = new Date();

      prismaMock.session.update.mockResolvedValue({
        sessionToken,
        status: SessionStatus.REVOKED,
        revokedAt,
        revokeReason: 'User initiated revocation',
      });

      const result = await service.revokeSession({ sessionToken });
      expect(result.status).toBe(SessionStatus.REVOKED);
      expect(prismaMock.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { sessionToken },
          data: expect.objectContaining({ status: SessionStatus.REVOKED }),
        }),
      );
    });
  });

  describe('revokeUserSessions', () => {
    it('should revoke all user sessions on credential change', async () => {
      const userId = 'user-1';

      prismaMock.session.updateMany.mockResolvedValue({ count: 3 });

      const result = await service.revokeUserSessions(userId);
      expect(result.count).toBe(3);
      expect(prismaMock.session.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId,
            status: SessionStatus.ACTIVE,
          },
          data: expect.objectContaining({
            status: SessionStatus.REVOKED,
            revokeReason: 'Sessions revoked on credential change',
          }),
        }),
      );
    });
  });

  describe('validateSession', () => {
    it('should return null for invalid session', async () => {
      prismaMock.session.findUnique.mockResolvedValue(null);
      const result = await service.validateSession('invalid-token');
      expect(result).toBeNull();
    });

    it('should return null for revoked session', async () => {
      prismaMock.session.findUnique.mockResolvedValue({
        sessionToken: 'token-1',
        status: SessionStatus.REVOKED,
        expiresAt: new Date(Date.now() + 3600000),
      });

      const result = await service.validateSession('token-1');
      expect(result).toBeNull();
    });

    it('should return session for valid token', async () => {
      const session = {
        id: 'session-1',
        sessionToken: 'token-1',
        status: SessionStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 3600000),
      };

      prismaMock.session.findUnique.mockResolvedValue(session);
      const result = await service.validateSession('token-1');
      expect(result).toEqual(session);
    });
  });
});
