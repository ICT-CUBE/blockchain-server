import {
  Injectable,
  Logger,
  type CanActivate,
  type ExecutionContext,
  type RawBodyRequest,
} from '@nestjs/common';

import { AppConfigService } from '../../config/app-config.service';
import type { RequestWithId } from '../../http/request-id.middleware';
import { HmacNonceRepository } from './hmac-nonce.repository';
import { verifyHmacRequest } from './hmac.guard';

const logger = new Logger('OperatorHmacGuard');

/**
 * Same verification mechanics as `HmacGuard`, but requires the *operator* key scope
 * (`HMAC_OPERATOR_*`) — TASK-14 §5: "조회 API는 HMAC 운영 key scope를 분리". Guards only the
 * operator-facing audit/failure/recovery endpoints, so a compromised Backend-integration inbound key
 * (used to create Operations) can never also read the audit trail, and vice versa. 검증 D10: a
 * correctly-signed inbound-key request here is a 403, not a 401.
 */
@Injectable()
export class OperatorHmacGuard implements CanActivate {
  constructor(
    private readonly config: AppConfigService,
    private readonly nonceRepository: HmacNonceRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RawBodyRequest<RequestWithId>>();
    await verifyHmacRequest(request, this.config, this.nonceRepository, 'operator', logger);
    return true;
  }
}
