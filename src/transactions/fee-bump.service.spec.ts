import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { FeeBumpService } from './fee-bump.service';

describe('FeeBumpService', () => {
  let service: FeeBumpService;
  let configService: ConfigService;
  const configValues: Record<string, string> = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeeBumpService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: string) =>
              configValues[key] ?? defaultValue ?? undefined,
            ),
          },
        },
      ],
    }).compile();

    service = module.get<FeeBumpService>(FeeBumpService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    Object.keys(configValues).forEach((k) => delete configValues[k]);
  });

  describe('isMainnetSubmissionEnabled', () => {
    it('returns false when FEATURE_MAINNET_PAYMENT_SUBMIT is unset', () => {
      expect(service.isMainnetSubmissionEnabled()).toBe(false);
    });

    it('returns false when flag is "false"', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = 'false';
      expect(service.isMainnetSubmissionEnabled()).toBe(false);
    });

    it('returns false when flag is empty string', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = '';
      expect(service.isMainnetSubmissionEnabled()).toBe(false);
    });

    it('returns false when flag is arbitrary string', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = 'yes';
      expect(service.isMainnetSubmissionEnabled()).toBe(false);
    });

    it('returns true when flag is "true"', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = 'true';
      expect(service.isMainnetSubmissionEnabled()).toBe(true);
    });

    it('returns true when flag is "TRUE" (case-insensitive)', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = 'TRUE';
      expect(service.isMainnetSubmissionEnabled()).toBe(true);
    });

    it('returns true when flag has whitespace padding', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = '  true  ';
      expect(service.isMainnetSubmissionEnabled()).toBe(true);
    });
  });

  describe('assertMainnetAllowed', () => {
    it('does not throw for TESTNET regardless of flag value', () => {
      // flag defaults to false
      expect(() => service.assertMainnetAllowed('TESTNET')).not.toThrow();
      expect(() => service.assertMainnetAllowed('testnet')).not.toThrow();
    });

    it('throws ForbiddenException for MAINNET when flag is disabled', () => {
      expect(() => service.assertMainnetAllowed('MAINNET')).toThrow(
        ForbiddenException,
      );
    });

    it('throws ForbiddenException for mainnet (lowercase) when flag is disabled', () => {
      expect(() => service.assertMainnetAllowed('mainnet')).toThrow(
        ForbiddenException,
      );
    });

    it('does not throw for MAINNET when flag is enabled', () => {
      configValues['FEATURE_MAINNET_PAYMENT_SUBMIT'] = 'true';
      expect(() => service.assertMainnetAllowed('MAINNET')).not.toThrow();
    });

    it('error message mentions the flag name', () => {
      try {
        service.assertMainnetAllowed('MAINNET');
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err.message).toContain('FEATURE_MAINNET_PAYMENT_SUBMIT');
      }
    });
  });
});
