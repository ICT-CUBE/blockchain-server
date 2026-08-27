import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { ApiError } from '../../../shared/http/api-error';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { WalletService } from '../application/wallet.service';
import { prepareWalletRequestSchema, type PrepareWalletRequest } from './wallet-request.schema';
import type { WalletResponse } from './wallet.response';

/** `POST /internal/v1/wallets` (prepare, synchronous) and `GET /internal/v1/wallets/:userId`
 * (lookup) — both HMAC only, no approval JWT (TASK-06 §4: "Wallet·조회·Metadata 준비는 HMAC만
 * 사용한다"). Never returns anything beyond address/provider/status — no key, share, or provider
 * token ever leaves `WalletService`. */
@Controller('internal/v1/wallets')
@UseGuards(HmacGuard)
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post()
  @HttpCode(200)
  async prepare(
    @Body(new ZodValidationPipe(prepareWalletRequestSchema)) body: PrepareWalletRequest,
  ): Promise<WalletResponse> {
    const wallet = await this.walletService.getOrCreate(body.userId);
    return {
      userId: wallet.userId,
      address: wallet.address,
      provider: wallet.provider,
      status: wallet.status,
    };
  }

  @Get(':userId')
  @HttpCode(200)
  async find(@Param('userId') userId: string): Promise<WalletResponse> {
    const wallet = await this.walletService.findByUserId(userId);
    if (!wallet) {
      throw new ApiError('WALLET_NOT_FOUND', `No custodial wallet provisioned for userId ${userId}`, 404);
    }
    return {
      userId: wallet.userId,
      address: wallet.address,
      provider: wallet.provider,
      status: wallet.status,
    };
  }
}
