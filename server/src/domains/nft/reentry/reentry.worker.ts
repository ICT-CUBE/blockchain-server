import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { AuditWriter } from '../../audit/application/audit-writer';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { OwnerConsentPurpose } from '../../transaction/signing/owner-consent';
import {
  TRANSACTION_SUBMISSION_PORT,
  type TransactionSubmissionPort,
} from '../../transaction/submission/transaction-submission.port';
import { ExternalConsentWorkerBase } from '../external-consent/external-consent.worker-base';

/** TASK-09 §5's Reentry worker — see `ExternalConsentWorkerBase` for the shared body. */
@Injectable()
export class ReentryWorker extends ExternalConsentWorkerBase {
  protected readonly logger = new Logger(ReentryWorker.name);
  protected readonly operationType = OperationType.REENTRY;
  protected readonly consentPurpose = OwnerConsentPurpose.REENTRY;
  protected readonly submittedReason = 'REENTRY_SUBMITTED';
  protected readonly label = 'Reentry';

  constructor(
    dataSource: DataSource,
    operationRepository: OperationRepository,
    assetLockRepository: AssetLockRepository,
    cubeNftReader: CubeNftReaderService,
    @Inject(TRANSACTION_SUBMISSION_PORT) submission: TransactionSubmissionPort,
    appConfig: AppConfigService,
    auditWriter: AuditWriter,
  ) {
    super(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      submission,
      appConfig,
      auditWriter,
    );
  }
}
