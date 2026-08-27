import type { WalletAccountStatus } from '../persistence/wallet-account.entity';

export interface WalletResponse {
  userId: string;
  address: string;
  provider: string;
  status: WalletAccountStatus;
}
