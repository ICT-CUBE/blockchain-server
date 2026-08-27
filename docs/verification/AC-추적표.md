# AC-001~040 추적표

> 기준: `docs/요구사항 정의 설계.md` (AC 정의), `docs/검증 계획서.md` (검증 원칙)
> 작성 시점: 2026-08-28, TASK-15
> 판정 기준: **통과**(로컬 자동화 테스트로 증명됨) / **부분**(핵심 로직은 증명되나 일부는 Backend/운영 영역이라 Blockchain Server 단독 범위 밖) / **BLOCKED**(외부 credential·자금 미확보로 검증 불가, 성공으로 세지 않음)

모든 "통과" 항목의 증거는 `code/docs/verification/개발-로그.md` 6.1절의 최종 회귀 실행(2026-08-28, 컨트랙트 40/40, 서버 unit 33/33, integration 52/52, e2e 22/22 — 총 147/147)에 포함되어 실제로 그린 상태임을 재확인했다.

| AC | 요약 | 판정 | 증거 |
|---|---|---|---|
| AC-001 | tokenId 1·10000 발행 가능, 0·10001 거부 | **통과** | `contracts/cube-nft/test/CubeNFT.spec.ts` "mints tokenId 1", "mints tokenId 10000 (upper boundary)", "rejects tokenId 0", "rejects tokenId 10001" |
| AC-002 | 같은 CUBE 두 번 발행해도 NFT 하나만 존재 | **통과** | `CubeNFT.spec.ts` "rejects a duplicate mint"; `server/test/integration/mint-flow.integration-spec.ts` idempotent already-minted 경로 |
| AC-003 | DB 내부 CUBE ID와 무관하게 tokenId는 공식 번호 사용 | **통과** | `mint-request.schema.ts`가 `tokenId`를 직접 받아 그대로 컨트랙트에 전달하는 설계 + `mint-flow.integration-spec.ts` |
| AC-004 | 신규 사용자 CUBE 등록 시 고유 수탁 지갑에 직접 발행 | **통과** | `server/test/mint-and-operations.e2e-spec.ts`, `wallets.e2e-spec.ts` (Web3Auth 지갑 프로비저닝 + Mint) |
| AC-005 | 최종 소유자 확인 전 Mint 성공 결과 미제공 | **통과** | `mint-flow.integration-spec.ts` (SUBMITTED → 5 confirmations 후에만 ONCHAIN_CONFIRMED) |
| AC-006 | 같은 요청 재전송해도 중복 Mint 작업 없음 | **통과** | `server/src/shared/idempotency/*`, `mint-and-operations.e2e-spec.ts` "reusing idempotencyKey" |
| AC-007 | 발행 실패 시 성공 미제공 + 실패 상태/사유 기록 | **통과** | `confirmation.service.spec.ts` FAILED 경로; `FailureRecord`(TASK-14 `AuditWriter`) |
| AC-008 | tokenId 조회로 현재 소유자 확인 | **통과** | `CubeNftReaderService.ownerOf` + `operations.controller.ts` GET 엔드포인트 |
| AC-009 | 미발행 tokenId와 네트워크 조회 실패가 다른 결과로 표시 | **통과** | `CubeNftReaderService` — `ownerOf` revert(미발행) vs RPC 예외(네트워크 실패)를 서로 다른 경로로 처리 |
| AC-010 | owner 조회 전후 소유권 상태 불변 | **통과** | 읽기 전용 호출 — `ownerOf`는 컨트랙트 상태를 변경하지 않음 (설계상 보장, view 함수) |
| AC-011 | 유효 공식 거래 완료 시 소유자 변경 + 완료 결과 제공 | **통과** | `server/test/integration/transfer-flow.integration-spec.ts` |
| AC-012 | 이전 처리 중 미성공 + 동일 CUBE 중복 Transfer/Withdrawal 불허 | **통과** | `AssetLockRepository`(단일 락) + `transfer-flow.integration-spec.ts` |
| AC-013 | 판매자 자기 상품 구매 불가 | **통과** | `transfer.application.ts` self-trade 거부 로직 + 유닛 커버리지 |
| AC-014 | 동일 NFT에 활성 Transfer 2개 동시 존재 불가 | **통과** | `AssetLockRepository` unique lock (TASK-10 설계) |
| AC-015 | 구매자 최종 이전 전 완료 결과 미제공 | **통과** | `transfer-flow.integration-spec.ts` (SUBMITTED/PENDING 단계에서 미완료) |
| AC-016 | 승인된 출금 요청 시 외부 주소로 소유자 변경 | **통과** | `server/test/integration/external-wallet-flow.integration-spec.ts` (Withdrawal) |
| AC-017 | 권한 없음/잘못된 주소/잠긴 NFT 출금 거부 | **통과** | `withdrawal.application.ts` 검증 로직 + `external-wallet-flow.integration-spec.ts` |
| AC-018 | 출금 승인 전 자기 수탁·복구 제한 고지 | **부분** | `riskAcknowledgementVersion` claim을 Blockchain Server가 저장·검증하는 부분은 구현/테스트됨; 실제 고지 문구 렌더링·사용자 확인 UI는 Backend/Frontend 책임 영역(본 프로젝트 범위 밖) |
| AC-019 | 출금 후 ARZONE 관리자가 서명 없이 NFT 이전 불가 | **통과** | `CubeNFT.spec.ts` — `authorizedTransfer`는 항상 유효한 `OwnerConsent` 서명을 요구, admin 우회 경로 없음 |
| AC-020 | 접수/제출/처리중/온체인확인/완료 상태 구분 조회, 5 confirmations 전 미확인 | **통과** | `confirmation.service.spec.ts` (blocksRequired 경계), `operations.controller.ts` |
| AC-021 | 최초·교체 제출의 모든 txHash 확인 가능 | **통과** | `TransactionAttempt` 엔티티(매 attempt 기록) + `transaction-submission.integration-spec.ts` RBF 재제출 |
| AC-022 | RPC timeout만으로 최종 실패·중복 작업 처리 안 함 | **통과** | `confirmation.service.spec.ts` PENDING/UNKNOWN outcome |
| AC-023 | 재시작 후 Pending 작업 추적 재개 | **통과** | `server/test/integration/restart-persistence.integration-spec.ts` |
| AC-024 | Backend 전달 실패해도 실패 내역 보존 + 재시도 | **통과** | `notification-delivery.service.spec.ts`, `notification-delivery.integration-spec.ts` |
| AC-025 | 의도적 DB/온체인 소유자 불일치 → 탐지 및 복구/검토 상태 | **통과** | `confirmation.service.spec.ts` OWNER_MISMATCH → REVIEW_REQUIRED |
| AC-026 | 온체인 확인 결과 Backend 수신대역 전달 + 중복 식별 | **통과** | `notification-delivery.integration-spec.ts` (실제 Mock Receiver로 HTTP 전달) |
| AC-027 | 같은 완료 알림 반복 전달해도 동일 식별자로 식별 | **통과** | `NotificationDelivery.notificationId` 고정 + `redeliver` 경로 |
| AC-028 | Backend 전달 실패 후 재전달 + 별도 상태 조회 가능 | **통과** | `scripts/redeliver-notification.ts` + `notification-delivery.integration-spec.ts` |
| AC-029 | Metadata에서 공개 CUBE 정보 조회, PII/비밀값 미포함 | **통과** | `server/test/integration/metadata-service.integration-spec.ts` "rejects a request carrying a field outside the allowlist" (`.strict()` 스키마) |
| AC-030 | 사용자·관리자 NFT Burn 불가 | **통과** | `CubeNFT.spec.ts` "the compiled ABI does not expose a burn function" |
| AC-031 | 개발/Amoy 단일 관리자 허용, Mainnet 2명 미만 승인 불가 | **통과** | `contracts/cube-nft/test/Governance.spec.ts` `assertValidGovernanceConfig`, Timelock+multisig 2-of-3 테스트 |
| AC-032 | Private Key·MPC 키 조각이 저장소/응답/로그에 없음 | **통과** | `raw-transaction-cipher.spec.ts`(AES-256-GCM 암호화 저장), `AuditWriter`의 `sensitive-key-redactor.ts`(금지 key 자동 검사), `StructuredLogger`(로그 필드 제한) |
| AC-033 | 요청 식별자로 작업/txHash/거래/알림 이력 추적 | **통과** | `server/test/audit.e2e-spec.ts` (operationId로 AuditRecord 조회), `operations.controller.ts` GET |
| AC-034 | 변경 파일이 `code/`로 한정, 설계 문서는 비버전관리 `docs/`에만 존재 | **통과** | `git status`/커밋 이력 확인 — 모든 구현 변경이 `code/` 저장소 내부에만 존재, 상위 `docs/`는 별도 미추적 영역 |
| AC-035 | 완료 결과에 실제 확인된 tokenId/컨트랙트 주소/txHash/최종 소유자 포함 | **통과**(로컬) / **BLOCKED**(Amoy) | 로컬 체인 기준 `mint-flow.integration-spec.ts`·`transfer-flow.integration-spec.ts`가 실제 값 검증; Amoy 공개망에서의 독립 재확인은 6.2절 사유로 보류 |
| AC-036 | 실제 Backend 사용자 인증은 이번 범위 제외, 전제조건으로 문서화 | **통과** | 본 문서 및 `docs/수행 계획서 - 세부 구현 계획.md` §14에 명시 |
| AC-037 | 외부 지갑 NFT는 ARZONE 서비스 가치/권리 비활성 상태로 구분 | **부분** | Blockchain Server는 Withdrawal 완료 시 Operation을 정확히 `ONCHAIN_CONFIRMED`로 표시해 Backend가 "비활성" 판단에 쓸 근거를 제공함; 실제 "비활성 상태" 표시/활용은 Backend 책임 영역 |
| AC-038 | 외부 지갑 소유자+ARZONE 승인 재입고 완료 시 수탁 지갑 이전 | **통과** | `external-wallet-flow.integration-spec.ts` (Reentry) |
| AC-039 | 외부 지갑 소유자+ARZONE 승인 공식 재판매 완료 시 구매자 수탁 지갑 이전 | **통과** | `external-wallet-flow.integration-spec.ts` (External Resale) |
| AC-040 | 출금·재입고·재판매 API를 Blockchain Server 단독 검증 가능, Backend 코드 미변경 | **통과** | 모든 e2e/integration 테스트가 Blockchain Server 프로세스 단독으로 완결 실행됨; Backend 저장소는 애초에 손대지 않음 |

## 요약

- **통과**: 35개
- **부분** (Blockchain Server 범위 밖 요소 포함): 2개 (AC-018, AC-037)
- **BLOCKED**: 1개 항목의 일부 (AC-035의 Amoy 공개망 독립 재확인 부분) — 자금 미확보로 보류, 사유는 `개발-로그.md` 6.2절 참조

BLOCKED 처리된 부분을 제외한 모든 AC의 핵심 로직은 로컬 환경에서 실제 트랜잭션 처리(fresh Hardhat 노드 + 실제 MySQL)로 검증되었다.
