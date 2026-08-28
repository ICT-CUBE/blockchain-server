import type { WalletAccountStatus } from '../persistence/wallet-account.entity';

/** `docs/openapi.yaml#/components/schemas/Wallet` (검증 개선안 §4.1 policy):
 * - `provider` is the *logical* custody provider the API contract promises (`WEB3AUTH`), not the
 *   physical adapter name;
 * - `providerAdapter` + `integrationReady` expose which adapter is actually bound, so a development
 *   deployment running the deterministic fake is visible without pretending to be real custody;
 * - `status` uses the persisted enum (`ACTIVE`/`DISABLED`);
 * - `createdAt` is included for audit/traceability. */
export interface WalletResponse {
  userId: string;
  address: string;
  provider: 'WEB3AUTH';
  providerAdapter: string;
  integrationReady: boolean;
  status: WalletAccountStatus;
  createdAt: string;
}
