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
