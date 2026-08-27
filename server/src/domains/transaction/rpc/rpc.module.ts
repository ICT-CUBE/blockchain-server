import { Module } from '@nestjs/common';

import { CubeNftReaderService } from './cube-nft-reader.service';
import { RpcService } from './rpc.service';

/** Standalone so `TransactionSubmissionModule` (TASK-10), `ConfirmationModule` (TASK-11), and every
 * domain worker that needs `ownerOf` (TASK-07+) can import it and share one `RpcService`
 * instance/connection pool rather than each opening its own to the same primary/backup endpoints. */
@Module({
  providers: [RpcService, CubeNftReaderService],
  exports: [RpcService, CubeNftReaderService],
})
export class RpcModule {}
