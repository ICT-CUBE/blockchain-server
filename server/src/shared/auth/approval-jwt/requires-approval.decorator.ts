import { SetMetadata } from '@nestjs/common';

import type { OperationType } from '../../domain/operation-type.enum';

export const REQUIRES_APPROVAL_KEY = 'requiresApprovalPurpose';

/** Marks a route as one of the five NFT-ownership-changing operations that requires an ARZONE
 * approval JWT (TASK-06 §4: "NFT 소유권 변경 요청이면 JWT ... 검증"). `ApprovalJwtGuard` reads this
 * to reject a token whose `purpose` claim doesn't match the route it was presented to — an
 * approval for one operation type can never authorize another. */
export const RequiresApproval = (purpose: OperationType) => SetMetadata(REQUIRES_APPROVAL_KEY, purpose);
