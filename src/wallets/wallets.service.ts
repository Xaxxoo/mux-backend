import {
  ConflictException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma/client';
import {
  WalletNetwork,
  WalletStatus,
  Wallet,
  WalletStatusResponse,
} from './domain/wallet.model';
import {
  DecryptionError,
  EncryptionService,
} from '../encryption/encryption.service';
import { SafeLogger } from '../common/safe-logger';
import { KeyDecryptionException } from '../key-management/exceptions/key-decryption.exception';
import { KeyManagementService } from '../key-management/key-management.service';
import { KeyType } from '../key-management/domain/key-types';
import { WebhookEventEmitterService } from '../webhooks/webhook-event-emitter.service';
import { WalletApiMetricsService } from './wallet-api-metrics.service';
import { WalletRetryService } from './wallet-retry.service';
import * as crypto from 'crypto';

/** Wallet shape safe to return from the API (no encrypted secret material). */
export type PublicWallet = Omit<Wallet, 'encryptedSecret'>;

export interface CreateWalletRequest {
  userId: string;
  network: WalletNetwork;
}

export interface WalletListFilters {
  userId?: string;
  network?: WalletNetwork;
  status?: WalletStatus;
  /** Include archived wallets in the results (excluded by default). */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface WalletListResult {
  data: Wallet[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface WalletCreationResult {
  wallet: Wallet;
  privateKey: string;
}

export interface SigningResult {
  signature: string;
  transactionHash?: string;
}

@Injectable()
export class WalletsService implements OnModuleDestroy {
  private readonly logger = new SafeLogger(WalletsService.name);
  private prisma: PrismaClient;

  constructor(
    private encryptionService: EncryptionService,
    private configService: ConfigService,
    private keyManagementService: KeyManagementService,
    @Optional() private webhookEventEmitter?: WebhookEventEmitterService,
    @Optional() private walletRetryService?: WalletRetryService,
    @Optional() private walletApiMetrics?: WalletApiMetricsService,
  ) {
    this.prisma = new PrismaClient({} as any);
  }

  async onModuleDestroy() {
    await this.prisma.$disconnect();
  }

  async onModuleInit() {
    if (!this.encryptionService.validateConfiguration()) {
      throw new Error('Wallet encryption service configuration is invalid');
    }
    this.logger.log('Wallet service initialized with encryption validation passed');
  }

  async createWallet(request: CreateWalletRequest): Promise<WalletCreationResult> {
    const startedAt = Date.now();
    const { userId, network } = request;
    const existingWallet = await this.prisma.wallet.findFirst({
      where: { userId, network },
    });
    if (existingWallet) {
      throw new ConflictException(`User already has a wallet on ${network}`);
    }

    try {
      const key = await this.generateKeyWithRetry('key_generation', {
        keyType: KeyType.STELLAR_ED25519,
        metadata: { userId, network },
      });
      const created = await this.prisma.wallet.create({
        data: {
          userId,
          publicKey: key.publicKey,
          encryptedSecret: key.encryptedData,
          network,
          status: 'ACTIVE',
          encryptionVersion: key.encryptionVersion,
          secretVersion: 1,
          keyVersion: 1,
        },
      });
      const privateKey = this.encryptionService.deserializeAndDecrypt(key.encryptedData);
      const wallet = this.mapPrismaWalletToDomain(created);
      this.emitDomainEvent('wallet.created', () =>
        this.webhookEventEmitter?.emitWalletCreated({
          walletId: wallet.id,
          userId: wallet.userId,
          publicKey: wallet.publicKey,
          network: wallet.network,
          status: wallet.status,
        }),
      );
      this.recordMetric('create', 'success', startedAt, network);
      return { wallet, privateKey };
    } catch (error) {
      this.logger.error('Failed to create wallet:', error);
      this.recordMetric('create', 'failure', startedAt, network);
      throw new Error('Wallet creation failed');
    }
  }

  async findWalletById(walletId: string): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    return this.mapPrismaWalletToDomain(wallet);
  }

  async findWalletByUser(userId: string, network: WalletNetwork): Promise<Wallet> {
    const wallet = await this.prisma.wallet.findFirst({ where: { userId, network } });
    if (!wallet) {
      throw new NotFoundException(`Wallet for user ${userId} on ${network} not found`);
    }
    return this.mapPrismaWalletToDomain(wallet);
  }

  async getDecryptedPrivateKey(walletId: string): Promise<string> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    if (wallet.status !== 'ACTIVE') {
      throw new Error(`Cannot sign with wallet in status: ${wallet.status}`);
    }
    try {
      return this.encryptionService.deserializeAndDecrypt(wallet.encryptedSecret);
    } catch (error) {
      if (error instanceof DecryptionError) {
        throw new KeyDecryptionException(walletId, error.code, 'Wallet key decryption failed — the key material may be corrupted or the encryption key may have changed');
      }
      this.logger.error(`Unexpected error decrypting wallet ${walletId}:`, error);
      throw new Error('Failed to access wallet private key');
    }
  }

  async signTransaction(walletId: string, transactionData: string): Promise<SigningResult> {
    try {
      const privateKey = await this.getDecryptedPrivateKey(walletId);
      return { signature: this.signWithPrivateKey(privateKey, transactionData) };
    } catch (error) {
      this.logger.error(`Failed to sign transaction with wallet ${walletId}:`, error);
      throw new Error('Transaction signing failed');
    }
  }

  async rotateWalletKey(walletId: string): Promise<WalletCreationResult> {
    const startedAt = Date.now();
    const existing = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!existing) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    try {
      const key = await this.generateKeyWithRetry('key_rotation', {
        keyType: KeyType.STELLAR_ED25519,
        metadata: { walletId, operation: 'rotation' },
      });
      const updated = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          publicKey: key.publicKey,
          encryptedSecret: key.encryptedData,
          secretVersion: existing.secretVersion + 1,
          encryptionVersion: key.encryptionVersion,
          updatedAt: new Date(),
        },
      });
      const wallet = this.mapPrismaWalletToDomain(updated);
      const privateKey = this.encryptionService.deserializeAndDecrypt(key.encryptedData);
      this.emitDomainEvent('wallet.rotated', () =>
        this.webhookEventEmitter?.emitWalletRotated({
          walletId: wallet.id,
          userId: wallet.userId,
          publicKey: wallet.publicKey,
          network: wallet.network,
          secretVersion: wallet.secretVersion,
        }),
      );
      this.recordMetric('key_rotate', 'success', startedAt, wallet.network);
      return { wallet, privateKey };
    } catch (error) {
      this.logger.error(`Failed to rotate wallet ${walletId}:`, error);
      this.recordMetric('key_rotate', 'failure', startedAt, existing.network);
      throw new Error('Wallet key rotation failed');
    }
  }

  async updateWalletStatus(walletId: string, status: WalletStatus, reason?: string): Promise<Wallet> {
    const startedAt = Date.now();
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    try {
      const updated = await this.prisma.wallet.update({
        where: { id: walletId },
        data: { status, statusReason: reason, statusChangedAt: new Date(), updatedAt: new Date() },
      });
      const mapped = this.mapPrismaWalletToDomain(updated);
      if (status === WalletStatus.SUSPENDED) {
        this.emitDomainEvent('wallet.suspended', () =>
          this.webhookEventEmitter?.emitWalletSuspended({
            walletId: mapped.id,
            userId: mapped.userId,
            reason,
          }),
        );
      }
      this.recordMetric('status_update', 'success', startedAt, mapped.network);
      return mapped;
    } catch (error) {
      this.logger.error(`Failed to update wallet ${walletId} status:`, error);
      this.recordMetric('status_update', 'failure', startedAt, wallet.network);
      throw new Error('Wallet status update failed');
    }
  }

  async getWalletStatus(walletId: string): Promise<WalletStatusResponse> {
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    return {
      id: wallet.id,
      status: wallet.status as WalletStatus,
      statusReason: wallet.statusReason,
      statusChangedAt: wallet.statusChangedAt,
      network: wallet.network as WalletNetwork,
      publicKey: wallet.publicKey,
      userId: wallet.userId,
      updatedAt: wallet.updatedAt,
    };
  }

  async activateWallet(walletId: string, statusReason?: string): Promise<Wallet> {
    const startedAt = Date.now();
    const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet) throw new NotFoundException(`Wallet with ID ${walletId} not found`);
    if (wallet.status !== 'PROVISIONING') {
      throw new Error(`Cannot activate wallet in status: ${wallet.status}. Only PROVISIONING wallets can be activated.`);
    }
    try {
      const updated = await this.prisma.wallet.update({
        where: { id: walletId },
        data: {
          status: 'ACTIVE',
          statusReason: statusReason ?? 'Wallet provisioned and activated',
          statusChangedAt: new Date(),
          updatedAt: new Date(),
        },
      });
      const mapped = this.mapPrismaWalletToDomain(updated);
      this.emitDomainEvent('wallet.activated', () =>
        this.webhookEventEmitter?.emitWalletActivated({
          walletId: mapped.id,
          userId: mapped.userId,
          publicKey: mapped.publicKey,
        }),
      );
      this.recordMetric('activate', 'success', startedAt, mapped.network);
      return mapped;
    } catch (error) {
      this.logger.error(`Failed to activate wallet ${walletId}:`, error);
      this.recordMetric('activate', 'failure', startedAt, wallet.network);
      throw new Error('Wallet activation failed');
    }
  }

  async findWalletsByUserId(userId: string): Promise<Wallet[]> {
    const wallets = await this.prisma.wallet.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return wallets.map((wallet) => this.mapPrismaWalletToDomain(wallet));
  }

  /** Retrieves the user's persisted default network preference (null if unset). */
  async getNetworkPreference(userId: string): Promise<{
    userId: string;
    defaultNetwork: WalletNetwork | null;
  }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);
    return {
      userId: user.id,
      defaultNetwork: (user.defaultNetwork as WalletNetwork) ?? null,
    };
  }

  /** Persists the user's default network preference for future wallet operations. */
  async setNetworkPreference(
    userId: string,
    network: WalletNetwork,
  ): Promise<{ userId: string; defaultNetwork: WalletNetwork }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);

    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { defaultNetwork: network },
    });

    this.logger.log(`Set network preference for user ${userId} to ${network}`);
    return {
      userId: updated.id,
      defaultNetwork: updated.defaultNetwork as WalletNetwork,
    };
  }

  async findAll(filters?: WalletListFilters): Promise<WalletListResult> {
    const where: Record<string, unknown> = {};

    if (filters?.userId) {
      where.userId = filters.userId;
    }
    if (filters?.network) {
      where.network = filters.network;
    }
    if (filters?.status) {
      where.status = filters.status;
    } else if (!filters?.includeArchived) {
      where.status = { not: WalletStatus.ARCHIVED };
    }

    const limit = filters?.limit ?? 20;
    const offset = filters?.offset ?? 0;

    const [wallets, total] = await Promise.all([
      this.prisma.wallet.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.wallet.count({ where }),
    ]);

    return {
      data: wallets.map((wallet) =>
        this.toPublicWallet(this.mapPrismaWalletToDomain(wallet)),
      ),
      total,
      limit,
      offset,
      hasMore: offset + wallets.length < total,
    };
  }

  create(createWalletDto: any) {
    return this.createWallet(createWalletDto);
  }

  async findOne(id: string) {
    const wallet = await this.findWalletById(id);
    return this.toPublicWallet(wallet);
  }

  async update(id: string, updateWalletDto: any) {
    const wallet = await this.updateWalletStatus(id, updateWalletDto.status);
    return this.toPublicWallet(wallet);
  }

  remove(id: string) {
    return this.prisma.wallet.delete({ where: { id } });
  }

  async archive(id: string, reason?: string) {
    const wallet = await this.archiveWallet(id, reason);
    return this.toPublicWallet(wallet);
  }

  private signWithPrivateKey(privateKey: string, data: string): string {
    const key = crypto.createPrivateKey({
      key: Buffer.from(privateKey, 'hex'),
      format: 'der',
      type: 'pkcs8',
    });
    return crypto.sign('sha256', Buffer.from(data), key).toString('hex');
  }

  private async generateKeyWithRetry(
    operation: string,
    request: { keyType: KeyType; metadata: Record<string, unknown> },
  ) {
    if (!this.walletRetryService) return this.keyManagementService.generateKey(request);
    return this.walletRetryService.execute({ operation }, () =>
      this.keyManagementService.generateKey(request),
    );
  }

  private emitDomainEvent(eventName: string, emit: () => Promise<void> | undefined): void {
    void Promise.resolve(emit()).catch((error: unknown) =>
      this.logger.warn(`Unable to emit ${eventName} domain event: ${String(error)}`),
    );
  }

  private recordMetric(
    operation: 'create' | 'activate' | 'key_rotate' | 'status_update',
    outcome: 'success' | 'failure',
    startedAt: number,
    network?: WalletNetwork,
  ): void {
    this.walletApiMetrics?.record({ operation, outcome, durationMs: Date.now() - startedAt, network });
  }

  private mapPrismaWalletToDomain(prismaWallet: any): Wallet {
    return {
      id: prismaWallet.id,
      userId: prismaWallet.userId,
      publicKey: prismaWallet.publicKey,
      encryptedSecret: prismaWallet.encryptedSecret,
      encryptionVersion: prismaWallet.encryptionVersion,
      secretVersion: prismaWallet.secretVersion,
      keyVersion: prismaWallet.keyVersion ?? 1,
      network: prismaWallet.network as WalletNetwork,
      status: prismaWallet.status as WalletStatus,
      statusReason: prismaWallet.statusReason,
      statusChangedAt: prismaWallet.statusChangedAt,
      rotatedFromId: prismaWallet.rotatedFromId,
      successorId: prismaWallet.successorId,
      createdAt: prismaWallet.createdAt,
      updatedAt: prismaWallet.updatedAt,
    };
  }
}
