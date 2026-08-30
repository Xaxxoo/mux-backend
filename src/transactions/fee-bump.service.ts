import {
  Injectable,
  Logger,
  BadRequestException,
  ServiceUnavailableException,
  NotFoundException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import {
  TransactionBuilder,
  Transaction,
  Networks,
  Server,
  BASE_FEE,
  Keypair,
} from 'stellar-sdk';
import { AxiosError } from 'axios';
import { createRequestIdAwareAxios } from '../common/http/request-id-axios';
import { WalletsService } from '../wallets/wallets.service';
import { TransactionsService } from './transactions.service';
import { TransactionStatus } from './domain/transaction.model';
import {
  mapHorizonResultToStatus,
  isInsufficientBalanceResult,
} from './horizon-result.mapper';
import { HorizonInsufficientBalanceException } from './domain/insufficient-balance.exception';
import { FeeBumpTransactionDto, FeeBumpResultDto } from './dto/fee-bump-transaction.dto';

/**
 * Builds, signs, and submits fee-bump transactions to Stellar Horizon.
 *
 * A fee-bump transaction wraps an already-signed inner transaction and re-signs
 * it with a sponsor fee-source account so that the sponsor pays the network fee.
 *
 * Flow:
 *   1. Decode and validate the inner transaction XDR.
 *   2. Retrieve the fee-source wallet's private key via WalletsService.
 *   3. Build a FeeBumpTransaction with TransactionBuilder.buildFeeBumpTransaction().
 *   4. Sign the outer envelope with the fee-source keypair.
 *   5. POST to Horizon /transactions.
 *   6. Persist the result (status, hash) on the internal Transaction record when
 *      a transactionId is supplied.
 */
@Injectable()
export class FeeBumpService {
  private readonly logger = new Logger(FeeBumpService.name);
  private readonly horizonTestnet: Server;
  private readonly horizonMainnet: Server;
  private readonly http = createRequestIdAwareAxios();

  constructor(
    private readonly configService: ConfigService,
    private readonly walletsService: WalletsService,
    private readonly transactionsService: TransactionsService,
    private readonly featureFlagService: FeatureFlagService,
  ) {
    const testnetUrl = this.configService.get<string>(
      'STELLAR_HORIZON_URL',
      'https://horizon-testnet.stellar.org',
    );
    const mainnetUrl = this.configService.get<string>(
      'STELLAR_HORIZON_MAINNET_URL',
      'https://horizon.stellar.org',
    );
    this.horizonTestnet = new Server(testnetUrl);
    this.horizonMainnet = new Server(mainnetUrl);
  }

  /**
   * Build, sign, and submit a fee-bump transaction.
   *
   * @throws BadRequestException – invalid XDR, missing wallet, or Horizon rejection
   * @throws ServiceUnavailableException – network/Horizon errors
   */
  async submitFeeBump(dto: FeeBumpTransactionDto): Promise<FeeBumpResultDto> {
    const {
      innerTransactionXdr,
      feeSourcePublicKey,
      feeSourceWalletId,
      transactionId,
      network,
    } = dto;

    // --- 0. Mainnet kill-switch ------------------------------------------------
    if (
      network === 'MAINNET' &&
      !this.featureFlagService.isEnabled('mainnet_payment_submit')
    ) {
      this.logger.warn(
        'Rejected fee-bump submission: mainnet_payment_submit flag is disabled',
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.FORBIDDEN,
          message:
            'Mainnet payment submission is not available at this time. (Flag: mainnet_payment_submit)',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    // --- 1. Decode inner transaction -----------------------------------------
    let innerTx: Transaction;
    try {
      innerTx = new Transaction(innerTransactionXdr, this.networkPassphrase(network));
    } catch {
      throw new BadRequestException(
        'innerTransactionXdr is not a valid signed transaction envelope',
      );
    }

    // --- 2. Retrieve fee-source private key ----------------------------------
    let feeSourcePrivateKey: string;
    try {
      feeSourcePrivateKey = await this.walletsService.getDecryptedPrivateKey(
        feeSourceWalletId,
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new BadRequestException(
          `Fee-source wallet ${feeSourceWalletId} not found`,
        );
      }
      throw err;
    }

    const feeSourceKeypair = Keypair.fromSecret(feeSourcePrivateKey);

    // Sanity-check that the wallet's public key matches the supplied one
    if (feeSourceKeypair.publicKey() !== feeSourcePublicKey) {
      throw new BadRequestException(
        'feeSourcePublicKey does not match the key material in feeSourceWalletId',
      );
    }

    // --- 3. Build fee-bump transaction envelope ------------------------------
    let feeBumpXdr: string;
    try {
      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        feeSourceKeypair,
        // Fee: use 10× the base fee to ensure acceptance
        String(parseInt(BASE_FEE) * 10),
        innerTx,
        this.networkPassphrase(network),
      );

      // --- 4. Sign with the fee-source key ------------------------------------
      feeBumpTx.sign(feeSourceKeypair);

      feeBumpXdr = feeBumpTx.toEnvelope().toXDR('base64');
    } catch (error) {
      this.logger.error('Failed to build fee-bump transaction:', error);
      throw new BadRequestException(
        `Failed to build fee-bump transaction: ${(error as Error).message}`,
      );
    }

    // --- 5. Submit to Horizon ------------------------------------------------
    const horizonUrl = this.horizonUrl(network);
    let horizonResult: any;

    try {
      const response = await this.http.post(
        `${horizonUrl}/transactions`,
        new URLSearchParams({ tx: feeBumpXdr }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
      horizonResult = response.data;
    } catch (err) {
      const axiosErr = err as AxiosError<any>;

      if (!axiosErr.response) {
        throw new ServiceUnavailableException(
          `Horizon network error: ${axiosErr.message}`,
        );
      }

      const status = axiosErr.response.status;
      const body = axiosErr.response.data ?? {};

      if (status >= 400 && status < 500) {
        const txCode =
          body.result_code ??
          body.extras?.result_codes?.transaction ??
          String(status);

        // Persist FAILED status when we have an associated transaction
        if (transactionId) {
          await this.safeUpdateStatus(transactionId, TransactionStatus.FAILED, txCode);
        }

        if (isInsufficientBalanceResult(body, txCode)) {
          throw new HorizonInsufficientBalanceException(
            transactionId ?? feeSourceWalletId,
            txCode,
          );
        }

        throw new BadRequestException(
          `Horizon rejected fee-bump transaction: ${txCode}`,
        );
      }

      throw new ServiceUnavailableException(`Horizon server error (${status})`);
    }

    const mappedStatus = mapHorizonResultToStatus(horizonResult);
    const stellarHash: string = horizonResult.hash ?? '';
    const feeCharged: string | undefined = horizonResult.fee_charged;

    // --- 6. Persist result on the internal transaction record ----------------
    if (transactionId) {
      await this.safeUpdateStatus(
        transactionId,
        mappedStatus,
        undefined,
        stellarHash,
        horizonResult.ledger,
        feeCharged,
      );
    }

    this.logger.log(
      `Fee-bump submitted — hash: ${stellarHash}, status: ${mappedStatus}` +
        (transactionId ? `, txId: ${transactionId}` : ''),
    );

    return {
      stellarHash,
      status: mappedStatus,
      transactionId,
      feeCharged,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private networkPassphrase(network: 'TESTNET' | 'MAINNET'): string {
    return network === 'MAINNET' ? Networks.PUBLIC : Networks.TESTNET;
  }

  private horizonUrl(network: 'TESTNET' | 'MAINNET'): string {
    return network === 'MAINNET'
      ? this.configService.get<string>(
          'STELLAR_HORIZON_MAINNET_URL',
          'https://horizon.stellar.org',
        )
      : this.configService.get<string>(
          'STELLAR_HORIZON_URL',
          'https://horizon-testnet.stellar.org',
        );
  }

  private async safeUpdateStatus(
    transactionId: string,
    status: TransactionStatus,
    statusReason?: string,
    stellarHash?: string,
    stellarLedger?: number,
    stellarFee?: string,
  ): Promise<void> {
    try {
      await this.transactionsService.updateStatus(transactionId, {
        status,
        ...(statusReason !== undefined && { statusReason }),
        ...(stellarHash !== undefined && { stellarHash }),
        ...(stellarLedger !== undefined && { stellarLedger }),
        ...(stellarFee !== undefined && { stellarFee }),
      });
    } catch (err) {
      this.logger.warn(
        `Failed to update transaction ${transactionId} after fee-bump: ${String(err)}`,
      );
    }
  }
}
