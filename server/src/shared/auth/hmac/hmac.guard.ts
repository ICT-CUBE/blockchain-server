import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import { ApiError } from '../../http/api-error';
import type { RequestWithId } from '../../http/request-id.middleware';
import {
  buildCanonicalString,
  computeHmacSignatureHex,
  safeCompareHex,
  type QueryValue,
} from './canonical-request';
import { HmacNonceReplayError, HmacNonceRepository } from './hmac-nonce.repository';
import { resolveHmacKeyAcrossScopes, type HmacScope } from './hmac-scope';

/** ±5 minutes, per the plan's HMAC policy — distinct from the approval JWT's own 30-minute
 * lifetime, which is checked separately by `ApprovalJwtGuard`. */
export const HMAC_TIMESTAMP_WINDOW_SECONDS = 300;

type HmacRequest = RawBodyRequest<RequestWithId>;

/**
 * Shared verification for both key scopes (TASK-06 §5 HMAC policy): required headers present,
 * timestamp within ±5min, signature valid under the current or (during rotation) previous key, and
 * the `(keyId, nonce)` pair not already used. Only logs key id, request id, and the verification
 * outcome — never the secret or the signature itself.
 *
 * 검증 D10: a request signed correctly with a key of the *other* scope is authenticated but not
 * authorized → 403 `HMAC_SCOPE_FORBIDDEN`; an unknown key id stays 401.
 */
export async function verifyHmacRequest(
  request: HmacRequest,
  config: AppConfigService,
  nonceRepository: HmacNonceRepository,
  requiredScope: HmacScope,
  logger: Logger,
): Promise<void> {
  const requestId = request.requestId;
  const reject = (keyId: string | undefined, reason: string): void => {
    logger.warn(
      `HMAC rejected: scope=${requiredScope} requestId=${requestId} keyId=${keyId ?? 'unknown'} result=${reason}`,
    );
  };

  const keyId = request.header('X-ARZONE-Key-Id');
  const timestampHeader = request.header('X-ARZONE-Timestamp');
  const nonce = request.header('X-ARZONE-Nonce');
  const signature = request.header('X-ARZONE-Signature');

  if (!keyId || !timestampHeader || !nonce || !signature) {
    reject(undefined, 'missing_headers');
    throw new ApiError('HMAC_MISSING_HEADERS', 'Missing required HMAC headers', 401);
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    reject(keyId, 'invalid_timestamp');
    throw new ApiError('HMAC_INVALID_TIMESTAMP', 'Invalid X-ARZONE-Timestamp', 401);
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > HMAC_TIMESTAMP_WINDOW_SECONDS) {
    reject(keyId, 'timestamp_out_of_range');
    throw new ApiError('HMAC_TIMESTAMP_OUT_OF_RANGE', 'Timestamp outside the allowed window', 401);
  }

  const resolved = resolveHmacKeyAcrossScopes(keyId, config.hmacInbound, config.hmacOperator);
  if (!resolved) {
    reject(keyId, 'unknown_key');
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
  const expectedSignature = computeHmacSignatureHex(resolved.key.secret, canonical);

  if (!safeCompareHex(expectedSignature, signature)) {
    reject(keyId, 'signature_mismatch');
    throw new ApiError('HMAC_SIGNATURE_MISMATCH', 'Signature verification failed', 401);
  }

  if (resolved.scope !== requiredScope) {
    reject(keyId, 'scope_forbidden');
    throw new ApiError(
      'HMAC_SCOPE_FORBIDDEN',
      `Key ${keyId} is authenticated but not authorized for this endpoint`,
      403,
    );
  }

  try {
    await nonceRepository.consume(keyId, nonce);
  } catch (error) {
    if (error instanceof HmacNonceReplayError) {
      reject(keyId, 'nonce_replayed');
      throw new ApiError('HMAC_NONCE_REPLAYED', 'Nonce already used', 401);
    }
    throw error;
  }

  logger.log(`HMAC verified: scope=${requiredScope} requestId=${requestId} keyId=${keyId} result=accepted`);
}

const logger = new Logger('HmacGuard');

/** Verifies every inbound Backend request against the inbound key scope. Apply to every internal
 * route; `ApprovalJwtGuard` (NFT-ownership-changing routes only) runs after this one. */
@Injectable()
export class HmacGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly nonceRepository: HmacNonceRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HmacRequest>();
    await verifyHmacRequest(request, this.config, this.nonceRepository, 'inbound', logger);
    return true;
  }
}
