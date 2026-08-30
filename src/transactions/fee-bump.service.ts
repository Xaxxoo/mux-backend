import {
  Injectable,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  TransactionBuilder,
  FeeBumpTransaction,
  Networks,
  Keypair,
  BASE_FEE,
} from 'stellar-sdk';

/**
 * Service for wrapping transactions in fee-bump envelopes.
 *
 * Includes the FEATURE_MAINNET_PAYMENT_SUBMIT kill-switch:
 * mainnet submission is blocked unless the flag is explicitly set to "true".
 * This ensures no accidental mainnet payments in staging or partially-configured
 * production environments.
 */
@Injectable()
export class FeeBumpService {
  private readonly logger = new Logger(FeeBumpService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns true when mainnet payment submission is allowed.
   *
   * The flag is fail-closed: any value other than the exact string "true"
   * (case-insensitive) keeps mainnet submission disabled.
   */
  isMainnetSubmissionEnabled(): boolean {
    const flag = this.configService.get<string>(
      'FEATURE_MAINNET_PAYMENT_SUBMIT',
      'false',
    );
    return flag.trim().toLowerCase() === 'true';
  }

  /**
   * Guards against mainnet submission when the kill-switch is off.
   *
   * @throws ForbiddenException if the network is MAINNET and the flag is disabled
   */
  assertMainnetAllowed(network: string): void {
    if (
      network.toUpperCase() === 'MAINNET' &&
      !this.isMainnetSubmissionEnabled()
    ) {
      this.logger.warn(
        'Mainnet payment submission blocked — FEATURE_MAINNET_PAYMENT_SUBMIT is not enabled',
      );
      throw new ForbiddenException(
        'Mainnet payment submission is currently disabled. ' +
          'Set FEATURE_MAINNET_PAYMENT_SUBMIT=true to enable.',
      );
    }
  }

  /**
   * Wraps a signed inner transaction XDR in a fee-bump envelope.
   *
   * The fee-bump source (sponsor) pays the fee on behalf of the inner
   * transaction source account.
   *
   * @param innerXdr  Base64 XDR of the signed inner transaction
   * @param network   "TESTNET" or "MAINNET"
   * @returns Base64 XDR of the fee-bump transaction (unsigned — caller must sign)
   */
  buildFeeBump(innerXdr: string, network: string): string {
    this.assertMainnetAllowed(network);

    const networkPassphrase =
      network.toUpperCase() === 'MAINNET' ? Networks.PUBLIC : Networks.TESTNET;

    const sponsorSecret = this.configService.get<string>(
      'STELLAR_SPONSOR_SECRET_KEY',
    );
    if (!sponsorSecret) {
      throw new ForbiddenException(
        'Fee-bump sponsor key is not configured (STELLAR_SPONSOR_SECRET_KEY)',
      );
    }

    const sponsorKeypair = Keypair.fromSecret(sponsorSecret);

    const innerTx = TransactionBuilder.fromXDR(
      innerXdr,
      networkPassphrase,
    );

    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      sponsorKeypair,
      (parseInt(BASE_FEE, 10) * 2).toString(), // 2x base fee for priority
      innerTx,
      networkPassphrase,
    ) as FeeBumpTransaction;

    const xdr = feeBump.toEnvelope().toXDR('base64');
    this.logger.log(
      `Built fee-bump envelope for network=${network}, sponsor=${sponsorKeypair.publicKey().substring(0, 12)}...`,
    );
    return xdr;
  }
}
