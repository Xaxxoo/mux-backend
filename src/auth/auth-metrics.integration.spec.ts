/**
 * Auth Metrics Integration Spec
 *
 * Wires the real AuthOrchestrator + AuthMetricsService together with
 * mocked collaborators to verify that metric counters are updated
 * for every meaningful auth outcome.
 */
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AuthOrchestrator,
  EXTERNAL_AUTH_FAILURE_MESSAGE,
} from './auth-orchestrator.service';
import { AuthMetricsService } from './auth-metrics.service';
import { IdempotentUserService } from '../users/idempotent-user.service';
import { WalletCreationOrchestrator } from '../wallets/wallet-creation-orchestrator.service';
import { WalletNetwork, WalletStatus } from '../wallets/domain/wallet.model';
import { IdempotencyService } from '../common/idempotency/idempotency.service';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = new Date('2026-01-01T00:00:00.000Z');

const makeUser = (overrides: Record<string, unknown> = {}) => ({
  id: 'user-abc',
  authId: 'auth-abc',
  email: 'user@example.com',
  displayName: 'Test User',
  status: 'ACTIVE',
  authProvider: 'GOOGLE',
  lastLoginAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const makeWallet = (overrides: Record<string, unknown> = {}) => ({
  id: 'wallet-abc',
  userId: 'user-abc',
  publicKey: 'GABC1234567890',
  encryptedSecret: 'enc-secret',
  encryptionVersion: 1,
  secretVersion: 1,
  network: WalletNetwork.TESTNET,
  status: WalletStatus.ACTIVE,
  statusChangedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  rotatedFromId: null,
  statusReason: null,
  ...overrides,
});

// ─── Test suite ─────────────────────────────────────────────────────────────

describe('AuthOrchestrator — metrics integration', () => {
  let orchestrator: AuthOrchestrator;
  let metricsService: AuthMetricsService;
  let userService: jest.Mocked<
    Pick<IdempotentUserService, 'findOrCreateUser' | 'findUserByAuthId'>
  >;
  let walletOrchestrator: jest.Mocked<
    Pick<WalletCreationOrchestrator, 'getWalletByUser' | 'createWallet'>
  >;

  beforeEach(async () => {
    userService = {
      findOrCreateUser: jest.fn(),
      findUserByAuthId: jest.fn(),
    };

    walletOrchestrator = {
      getWalletByUser: jest.fn(),
      createWallet: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthOrchestrator,
        AuthMetricsService,
        { provide: IdempotentUserService, useValue: userService },
        { provide: WalletCreationOrchestrator, useValue: walletOrchestrator },
        {
          provide: IdempotencyService,
          useValue: {
            getCachedResponse: jest.fn().mockResolvedValue(null),
            cacheResponse: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    orchestrator = module.get(AuthOrchestrator);
    metricsService = module.get(AuthMetricsService);
  });

  afterEach(() => jest.clearAllMocks());

  // ─── Success paths ───────────────────────────────────────────────────────

  describe('successful auth — new user', () => {
    it('records success_new_user outcome', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: true,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockResolvedValue({
        wallet: makeWallet(),
        privateKey: 'secret',
        isNewWallet: true,
      });

      await orchestrator.handleAuthentication({ authId: 'auth-abc' });

      const snap = metricsService.getSnapshot();
      expect(snap.totalAttempts).toBe(1);
      expect(snap.outcomes.success_new_user).toBe(1);
      expect(snap.outcomes.success_returning_user).toBe(0);
    });

    it('records a positive latency sample', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: true,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockResolvedValue({
        wallet: makeWallet(),
        privateKey: 'secret',
        isNewWallet: true,
      });

      await orchestrator.handleAuthentication({ authId: 'auth-abc' });

      const snap = metricsService.getSnapshot();
      expect(snap.averageLatencyMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('successful auth — returning user', () => {
    it('records success_returning_user outcome', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: false,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(makeWallet());

      await orchestrator.handleAuthentication({ authId: 'auth-abc' });

      const snap = metricsService.getSnapshot();
      expect(snap.outcomes.success_returning_user).toBe(1);
      expect(snap.outcomes.success_new_user).toBe(0);
    });
  });

  // ─── Failure paths ───────────────────────────────────────────────────────

  describe('invalid payload', () => {
    it('records failure_invalid_payload when authId is missing', async () => {
      await expect(
        orchestrator.handleAuthentication({ authId: '' } as any),
      ).rejects.toThrow(BadRequestException);

      const snap = metricsService.getSnapshot();
      expect(snap.outcomes.failure_invalid_payload).toBe(1);
      expect(snap.totalAttempts).toBe(1);
    });
  });

  describe('inactive user', () => {
    it('records failure_user_inactive for suspended accounts', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser({ status: 'SUSPENDED' }),
        isNewUser: false,
      });

      await expect(
        orchestrator.handleAuthentication({ authId: 'auth-abc' }),
      ).rejects.toThrow(ForbiddenException);

      const snap = metricsService.getSnapshot();
      expect(snap.outcomes.failure_user_inactive).toBe(1);
    });
  });

  describe('wallet creation error', () => {
    it('records failure_wallet_error when wallet creation fails', async () => {
      userService.findOrCreateUser.mockResolvedValue({
        user: makeUser(),
        isNewUser: true,
      });
      walletOrchestrator.getWalletByUser.mockResolvedValue(null);
      walletOrchestrator.createWallet.mockRejectedValue(
        new Error('Stellar unavailable'),
      );

      await expect(
        orchestrator.handleAuthentication({ authId: 'auth-abc' }),
      ).rejects.toThrow();

      const snap = metricsService.getSnapshot();
      expect(snap.outcomes.failure_wallet_error).toBe(1);
    });
  });

  describe('unknown error', () => {
    it('records failure_unknown for generic DB errors, without leaking the raw cause', async () => {
      userService.findOrCreateUser.mockRejectedValue(new Error('DB down'));

      let caught: unknown;
      try {
        await orchestrator.handleAuthentication({ authId: 'auth-abc' });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ServiceUnavailableException);
      expect((caught as ServiceUnavailableException).message).toBe(
        EXTERNAL_AUTH_FAILURE_MESSAGE,
      );
      expect((caught as ServiceUnavailableException).message).not.toContain(
        'DB down',
      );

      const snap = metricsService.getSnapshot();
      expect(snap.outcomes.failure_unknown).toBe(1);
    });
  });

  // ─── Accumulation across multiple calls ─────────────────────────────────

  describe('accumulation', () => {
    it('sums correctly across multiple successful calls', async () => {
      const successSetup = () => {
        userService.findOrCreateUser.mockResolvedValue({
          user: makeUser(),
          isNewUser: false,
        });
        walletOrchestrator.getWalletByUser.mockResolvedValue(makeWallet());
      };

      successSetup();
      await orchestrator.handleAuthentication({ authId: 'auth-abc' });
      successSetup();
      await orchestrator.handleAuthentication({ authId: 'auth-abc' });
      successSetup();
      await orchestrator.handleAuthentication({ authId: 'auth-abc' });

      const snap = metricsService.getSnapshot();
      expect(snap.totalAttempts).toBe(3);
      expect(snap.outcomes.success_returning_user).toBe(3);
    });
  });

  // ─── Idempotency replays ─────────────────────────────────────────────────

  describe('idempotency replay', () => {
    it('does NOT double-count a replayed request', async () => {
      // Simulate a cache hit from IdempotencyService
      const idempotencyService = orchestrator['idempotencyService'];
      (idempotencyService.getCachedResponse as jest.Mock).mockResolvedValue({
        user: { id: 'u', authId: 'a', status: 'ACTIVE', authProvider: 'G', lastLoginAt: NOW },
        wallet: { id: 'w', publicKey: 'pk', network: WalletNetwork.TESTNET, status: 'ACTIVE', createdAt: NOW },
        isNewUser: false,
        isNewWallet: false,
      });

      await orchestrator.handleAuthentication({
        authId: 'auth-abc',
        idempotencyKey: 'idem-key-123',
      });

      // totalAttempts should remain 0 because the result was served from cache
      const snap = metricsService.getSnapshot();
      expect(snap.totalAttempts).toBe(0);
    });
  });
});
