# FEATURE_MAINNET_PAYMENT_SUBMIT — Mainnet Kill-Switch

## Overview

`FEATURE_MAINNET_PAYMENT_SUBMIT` is a **fail-closed** feature flag that gates
all payment submissions to Stellar **mainnet**. When the flag is absent or set
to anything other than `"true"`, mainnet submission is rejected with HTTP 403.

Testnet transactions are **never** affected by this flag.

## Behaviour Matrix

| `FEATURE_MAINNET_PAYMENT_SUBMIT` | Testnet | Mainnet |
|----------------------------------|---------|---------|
| _(unset / missing)_             | Allowed | **Blocked (403)** |
| `"false"`                        | Allowed | **Blocked (403)** |
| `"true"`                         | Allowed | Allowed |
| `"TRUE"` / `" true "`           | Allowed | Allowed _(case/whitespace tolerant)_ |

## Where It Is Enforced

1. **`FeeBumpService.assertMainnetAllowed(network)`** — called before building
   fee-bump envelopes and directly by `HorizonSubmissionService` before
   submitting any transaction to mainnet Horizon.
2. The check is **fail-closed**: the default value is `"false"`.

## Environment Variable

```env
# Enable mainnet payment submission (default: false)
FEATURE_MAINNET_PAYMENT_SUBMIT=false
```

- **Type**: String (`"true"` / `"false"`)
- **Required**: No — defaults to `"false"` (mainnet blocked)
- **Convention**: `FEATURE_` prefix for all feature flags

## Operational Guidance

### Enabling for Production

```bash
# In your deployment environment (e.g. Railway, Render, K8s):
FEATURE_MAINNET_PAYMENT_SUBMIT=true
```

Only enable this flag when:
- The Stellar sponsor account is funded on mainnet
- `STELLAR_HORIZON_URL` points to a mainnet Horizon endpoint
- `STELLAR_SPONSOR_SECRET_KEY` holds a valid mainnet secret
- All payment limits and security policies are reviewed

### Emergency Disable (Kill-Switch)

To immediately halt all mainnet payments without a code deploy:
1. Set `FEATURE_MAINNET_PAYMENT_SUBMIT=false` in the environment
2. Restart the service (or rely on hot config reload if available)
3. All in-flight mainnet submissions will be rejected with 403

### Monitoring

When the kill-switch blocks a request, the service logs:
```
WARN [FeeBumpService] Mainnet payment submission blocked — FEATURE_MAINNET_PAYMENT_SUBMIT is not enabled
```

Look for this log line in your observability stack to detect misconfigured
clients or unexpected mainnet traffic.

## Security Notes

- **Never** set this flag to `true` in local development or CI unless you
  explicitly intend to submit to mainnet.
- The flag value is **not** logged to avoid leaking configuration state.
- `STELLAR_SPONSOR_SECRET_KEY` and `WALLET_ENCRYPTION_KEY` must **never**
  appear in logs.
