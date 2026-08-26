import { randomBytes, randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { TransactionAttempt } from '../../src/domains/transaction/persistence/transaction-attempt.entity';
import { createTestDataSource } from './test-data-source';

/** Simulates a server restart by fully closing and reopening the DataSource (a fresh connection
 * pool, exactly as a new process would create), and proving every write from "before" is still
 * readable "after" (TASK-04 §11: "재시작 후 유지 확인"). */
describe('Persistence across a simulated restart (integration)', () => {
  it('Operation, its history, and a TransactionAttempt all survive a connection close/reopen', async () => {
    const idempotencyKey = randomUUID();
    const tokenId = Math.floor(Math.random() * 10_000) + 1;
    const txHash = `0x${randomBytes(32).toString('hex')}`;

    let operationId: string;

    // --- "before restart" ---
    {
      const dataSource: DataSource = createTestDataSource();
      await dataSource.initialize();
      const operationRepository = new OperationRepository(dataSource);

      const { operation } = await operationRepository.createOrGet({
        idempotencyKey,
        type: OperationType.MINT,
        requestHash: 'f'.repeat(64),
        tokenId,
      });
      operationId = operation.id;

      await operationRepository.transition(
        operationId,
        OperationStatus.REQUESTED,
        OperationStatus.SUBMITTED,
        'submitted',
      );

      await dataSource.getRepository(TransactionAttempt).insert({
        id: randomUUID(),
        operationId,
        attemptNo: 1,
        chainId: 80002,
        signerAddress: '0x7777777777777777777777777777777777777777',
        transactionNonce: '1',
        txHash,
        rawTransactionCiphertext: 'ciphertext-placeholder',
      });

      await dataSource.destroy();
    }

    // --- "after restart": a completely fresh DataSource, as a new process would create ---
    {
      const dataSource: DataSource = createTestDataSource();
      await dataSource.initialize();
      const operationRepository = new OperationRepository(dataSource);

      const operation = await operationRepository.findById(operationId);
      expect(operation).not.toBeNull();
      expect(operation?.status).toBe(OperationStatus.SUBMITTED);

      const history = await operationRepository.findHistory(operationId);
      expect(history.map((h) => h.toStatus)).toEqual([OperationStatus.REQUESTED, OperationStatus.SUBMITTED]);

      const attempts = await dataSource.getRepository(TransactionAttempt).find({ where: { operationId } });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]!.txHash).toBe(txHash);

      await dataSource.destroy();
    }
  });
});
