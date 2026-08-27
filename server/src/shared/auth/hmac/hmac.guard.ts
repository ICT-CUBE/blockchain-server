import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import type { HmacKeyConfig } from '../../config/app-config';
import { ApiError } from '../../http/api-error';
import type { RequestWithId } from '../../http/request-id.middleware';
import {
  buildCanonicalString,
  computeHmacSignatureHex,
  safeCompareHex,
  type QueryValue,
} from './canonical-request';
import { HmacNonceReplayError, HmacNonceRepository } from './hmac-nonce.repository';

/** ±5 minutes, per the plan's HMAC policy — distinct from the approval JWT's own 30-minute
 * lifetime, which is checked separately by `ApprovalJwtGuard`. */
export const HMAC_TIMESTAMP_WINDOW_SECONDS = 300;

type HmacRequest = RawBodyRequest<RequestWithId>;

const logger = new Logger('HmacGuard');

/** Verifies every inbound Backend request per the plan's HMAC policy (TASK-06 §5): required
 * headers present, timestamp within ±5min, signature valid under the current or (during rotation)
 * previous key, and the `(keyId, nonce)` pair not already used. Only logs key id, request id, and
 * the verification outcome — never the secret or the signature itself. Apply to every internal
 * route; `ApprovalJwtGuard` (NFT-ownership-changing routes only) runs after this one. */
@Injectable()
export class HmacGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly nonceRepository: HmacNonceRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HmacRequest>();
    const requestId = request.requestId;

    const keyId = request.header('X-ARZONE-Key-Id');
    const timestampHeader = request.header('X-ARZONE-Timestamp');
    const nonce = request.header('X-ARZONE-Nonce');
    const signature = request.header('X-ARZONE-Signature');

    if (!keyId || !timestampHeader || !nonce || !signature) {
      this.reject(requestId, undefined, 'missing_headers');
      throw new ApiError('HMAC_MISSING_HEADERS', 'Missing required HMAC headers', 401);
    }

    const timestamp = Number(timestampHeader);
    if (!Number.isInteger(timestamp)) {
      this.reject(requestId, keyId, 'invalid_timestamp');
      throw new ApiError('HMAC_INVALID_TIMESTAMP', 'Invalid X-ARZONE-Timestamp', 401);
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSeconds - timestamp) > HMAC_TIMESTAMP_WINDOW_SECONDS) {
      this.reject(requestId, keyId, 'timestamp_out_of_range');
      throw new ApiError('HMAC_TIMESTAMP_OUT_OF_RANGE', 'Timestamp outside the allowed window', 401);
    }

    const matchedKey = this.resolveKey(keyId);
    if (!matchedKey) {
      this.reject(requestId, keyId, 'unknown_key');
      throw new ApiError('HMAC_UNKNOWN_KEY', 'Unknown key id', 401);
    }

    const rawBody = request.rawBody ?? Buffer.alloc(0);
    const canonical = buildCanonicalString({
      method: request.method,
      path: request.path,
      query: request.query as Record<string, QueryValue>,
      timestamp: timestampHeader,
      nonce,
      rawBody,
    });
    const expectedSignature = computeHmacSignatureHex(matchedKey.secret, canonical);

    if (!safeCompareHex(expectedSignature, signature)) {
      this.reject(requestId, keyId, 'signature_mismatch');
      throw new ApiError('HMAC_SIGNATURE_MISMATCH', 'Signature verification failed', 401);
    }

    try {
      await this.nonceRepository.consume(keyId, nonce);
    } catch (error) {
      if (error instanceof HmacNonceReplayError) {
        this.reject(requestId, keyId, 'nonce_replayed');
        throw new ApiError('HMAC_NONCE_REPLAYED', 'Nonce already used', 401);
      }
      throw error;
    }

    logger.log(`HMAC verified: requestId=${requestId} keyId=${keyId} result=accepted`);
    return true;
  }

  private resolveKey(keyId: string): HmacKeyConfig | null {
    const { current, previous } = this.config.hmacInbound;
    if (keyId === current.keyId) {
      return current;
    }
    if (previous && keyId === previous.keyId) {
      return previous;
    }
    return null;
  }

  private reject(requestId: string, keyId: string | undefined, reason: string): void {
    logger.warn(`HMAC rejected: requestId=${requestId} keyId=${keyId ?? 'unknown'} result=${reason}`);
  }
}
