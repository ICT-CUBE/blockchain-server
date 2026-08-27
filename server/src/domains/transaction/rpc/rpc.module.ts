import { Module } from '@nestjs/common';

import { RpcService } from './rpc.service';

/** Standalone so both `TransactionSubmissionModule` (TASK-10) and `ConfirmationModule` (TASK-11)
 * can import it and share one `RpcService` instance/connection pool rather than each opening its
 * own to the same primary/backup endpoints. */
@Module({
  providers: [RpcService],
  exports: [RpcService],
})
export class RpcModule {}
