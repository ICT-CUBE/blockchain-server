import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

export enum MetadataDependencyKind {
  METADATA_JSON = 'METADATA_JSON',
  IMAGE = 'IMAGE',
  OTHER = 'OTHER',
}

export enum MetadataPinStatus {
  PENDING = 'PENDING',
  PINNED = 'PINNED',
  FAILED = 'FAILED',
}

export enum MetadataPreservationStatus {
  PENDING = 'PENDING',
  /** A `prepare()` call has claimed this row and is mid-`preserve()` — the atomic
   * `PENDING/FAILED → SUBMITTING` transition is what stops a concurrent or repeated `prepare()`
   * from double-submitting the same CID (검증 문제 — preservation 멱등성). Transient; resolves to
   * `PENDING` (with a request id) or `FAILED` within one HTTP call. The status API maps it to
   * `PENDING`. */
  SUBMITTING = 'SUBMITTING',
  PRESERVED = 'PRESERVED',
  FAILED = 'FAILED',
}

/** One ARZONE-managed content-addressed dependency (the metadata JSON itself, or an asset it
 * references such as an image) for a tokenId's immutable metadata (TASK-13). A token's metadata is
 * only READY — and Mint only accepted — once every dependency row for it is PINNED. Kept minimal
 * here; TASK-13 owns the actual pinning/preservation/canonicalization logic. */
@Entity('metadata_dependencies')
@Unique(['tokenId', 'cid'])
export class MetadataDependency {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'token_id', type: 'int', unsigned: true })
  tokenId!: number;

  @Column({ type: 'varchar', length: 255 })
  cid!: string;

  @Column({ type: 'enum', enum: MetadataDependencyKind })
  kind!: MetadataDependencyKind;

  @Column({ name: 'pin_status', type: 'enum', enum: MetadataPinStatus, default: MetadataPinStatus.PENDING })
  pinStatus!: MetadataPinStatus;

  @Column({
    name: 'preservation_status',
    type: 'enum',
    enum: MetadataPreservationStatus,
    default: MetadataPreservationStatus.PENDING,
  })
  preservationStatus!: MetadataPreservationStatus;

  /** The archival provider's pin-request id (Filebase `requestid`), kept so preservation status can
   * be reconciled later via `PreservationPort.checkStatus` — `PRESERVED` is only set once that
   * reports `pinned` (검증 문제 2·3). Null until `preserve()` returns, or when it failed outright. */
  @Column({ name: 'preservation_request_id', type: 'varchar', length: 255, nullable: true })
  preservationRequestId!: string | null;

  /** Fencing token for the current `SUBMITTING` claim (검증 피드백). Rewritten on every claim so the
   * claim `UPDATE` genuinely changes the row (stale re-claim would otherwise be a no-op — MySQL
   * `affectedRows` counts *changed* rows, and `ON UPDATE` would not refresh `updated_at`). A late
   * `preserve()` completion only writes its result back when this still matches its own token, so a
   * submitter that returns after its claim was reclaimed cannot clobber the newer generation. */
  @Column({ name: 'preservation_claim_token', type: 'char', length: 36, nullable: true })
  preservationClaimToken!: string | null;

  @Column({ type: 'char', length: 64, nullable: true })
  checksum!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
