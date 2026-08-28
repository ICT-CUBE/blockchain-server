import { Module } from '@nestjs/common';

import { ConsentDryRunService } from './consent-dry-run.service';
import { CubeNftReaderService } from './cube-nft-reader.service';
import { RpcService } from './rpc.service';

/** Standalone so `TransactionSubmissionModule` (TASK-10), `ConfirmationModule` (TASK-11), and every
 * domain worker that needs `ownerOf` (TASK-07+) can import it and share one `RpcService`
 * instance/connection pool rather than each opening its own to the same primary/backup endpoints.
 * `ConsentDryRunService` (검증 D3) lives here too: it is pure read-side RPC, no signing. */
@Module({
  providers: [RpcService, CubeNftReaderService, ConsentDryRunService],
  exports: [RpcService, CubeNftReaderService, ConsentDryRunService],
})
export class RpcModule {}
