# ARZONE CUBE NFT — Blockchain Server

CUBE NFT 컨트랙트와, ARZONE Backend를 대신해 온체인 상태(발행·소유권 이전·확정·알림)를 관리하는 독립 Blockchain Server. `docs/수행 계획서 - 세부 구현 계획.md`(이 저장소 상위, 비버전관리 영역)의 TASK-01~15를 구현한다.

## 구성

npm workspaces 기반 모노레포:

| 워크스페이스 | 내용 |
|---|---|
| `contracts/cube-nft` | UUPS 업그레이더블 `CubeNFT` 컨트랙트 (Hardhat) — 고정 tokenId 범위(1~10000), 역할 기반 Mint/Transfer, 표준 ERC-721 전송 비활성화, Burn 없음, Timelock+multisig 거버넌스 |
| `server` | NestJS 기반 Blockchain Server — 지갑 프로비저닝, Mint/Transfer/Withdrawal/Reentry/External-Resale, 트랜잭션 제출·재시도·확정, Backend 완료 webhook, Metadata pinning, 감사/실패 기록 |

### server 도메인 구조 (`server/src/domains`)

- `wallet` — MPC 수탁 지갑 (Web3Auth fake/real 어댑터)
- `nft` — Mint, Transfer, Withdrawal, Reentry, External-Resale, External-Consent-Challenge
- `transaction` — nonce 조정, 서명·제출, RBF, confirmation, reconciliation, RPC
- `operation` — Operation 상태 기계, 잠금(AssetLock), 완결(Finalizer)
- `notification` — Backend 완료 webhook outbox·전달
- `metadata` — Pinata(hot pin) + Filebase(장기 보존) pinning/preservation (fake/real 어댑터)
- `audit` — 감사/실패 기록(`AuditWriter`), 운영자 조회 API

모든 외부 연동(Web3Auth, Pinata, Filebase)은 `provider=fake|real` 환경변수로 전환되는 어댑터 포트 패턴을 따른다 — `fake`는 credential 없이 전체 파이프라인을 로컬에서 실행 가능하게 하는 결정적(deterministic) 구현이다.

## 요구 사항

- Node.js `24.x` (`.nvmrc` 참고)
- MySQL 8 (`docker-compose.yml`이 로컬용 인스턴스를 제공)
- Amoy/Mainnet 배포 시: Infura 등 RPC 엔드포인트, 자금이 있는 배포자 지갑

> **MySQL 시간대**: 서버는 연결 시마다 세션을 `time_zone = '+00:00'`로 고정하므로(`enforce-utc-session-timezone.ts`),
> 호스트 MySQL이 `Asia/Seoul` 등 비-UTC로 돌아가도 타임스탬프·`LONG_PENDING`·signed-tx 복구가 UTC 환경과
> 동일하게 동작한다. 통합 테스트도 마찬가지다(`test:integration`은 UTC·KST MySQL에서 모두 63/63).

## 시작하기

```bash
npm install                       # 루트에서 워크스페이스 전체 설치
cp .env.example .env              # 값 채우기 — 각 섹션 주석 참고
docker compose up -d mysql        # 로컬 MySQL (또는 직접 준비한 MySQL 8 사용)
npm run migration:run --workspace=server

npm run build                     # contracts + server 빌드
npm run test                      # contracts + server 유닛 테스트
```

### 로컬 체인에서 전체 흐름 실행

```bash
npm run node --workspace=contracts/cube-nft            # 별도 터미널: Hardhat 노드 (127.0.0.1:8545)
npm run deploy:localhost --workspace=contracts/cube-nft # 그 노드에 배포 → contracts/deployments/localhost.json
npm run start:dev --workspace=server                    # 서버 기동
```

> `deploy:local`(= `--network hardhatMainnet`, 인프로세스 시뮬레이션)과 `deploy:localhost`(= `--network localhost`,
> 위에서 띄운 `npm run node`에 접속)는 서로 다른 네트워크다. `--network`를 뒤에 또 붙이지 말 것 —
> 스크립트에 이미 포함돼 있어 `HHE510: Options of type "STRING_WITHOUT_DEFAULT" cannot be repeated` 오류가 난다.

### 서버 테스트 (실제 로컬 체인 + 실제 MySQL 필요)

```bash
DATABASE_URL=mysql://cube_nft:cube_nft_test_pw@127.0.0.1:3307/cube_nft_test \
  npm run test:integration --workspace=server   # 실제 체인/DB 연동

DATABASE_URL=... npm run test:e2e --workspace=server   # 전체 HTTP 스택
```

integration/e2e는 **fresh Hardhat 노드 + 재배포 + 깨끗한 테스트 DB**를 전제로 한다 — 절차는 `docs/verification/개발-로그.md`(상위, 비버전관리) 5절 참고.

## Amoy 배포

```bash
npm run deploy:amoy --workspace=contracts/cube-nft
```

`AMOY_RPC_URL_PRIMARY`, `AMOY_DEPLOYER_PRIVATE_KEY`가 `.env`에 필요하다. 배포자 지갑에는 실제 Amoy POL 잔액이 있어야 한다.

## 검증 계획서 명령 (2026-08-28 remediation)

`docs/5. 검증 계획서.md` §4가 호출하는 이름 그대로 root script를 제공한다.

| 명령 | 내용 |
|---|---|
| `npm run typecheck` | contracts + server `tsc --noEmit` |
| `npm run test:unit` / `test:contract` / `test:integration` / `test:api` | server unit · Hardhat · 실제 체인+DB integration · 전체 HTTP e2e(OpenAPI contract test 포함) |
| `npm run test:nonfunctional` | 민감정보 redaction corpus + 다중 규칙 scanner 검증 |
| `npm run test:amoy` | Amoy 인수(`server/scripts/amoy-acceptance.ts`) — `AMOY_RPC_URL_PRIMARY`, 자금 있는 `MINT/RELAYER_SIGNER_PRIVATE_KEY`, `contracts/deployments/amoy.json` 필요. 없으면 **실패**(skip 아님). JSON 리포트는 `reports/` |
| `npm run auth:headers -- --method POST --path /internal/v1/wallets --body '{"userId":"u1"}' [--scope operator] [--jwt '{...}'] [--out file]` | curl `-H @file`용 HMAC(+승인 JWT) 헤더 생성. secret은 출력하지 않음 |
| `npm run scan:sensitive -- <file\|dir>... [--secret-env NAME,...] [--strict]` | 로그·DB dump에서 signed raw tx(typed/legacy)·65B 서명·RPC payload echo·JWT·`--secret-env` 리터럴을 검사(**gating**, 발견 시 exit 1). 32바이트 hex(`POSSIBLE_KEY_32B`)는 keccak 해시와 형태가 같아 **advisory**로만 출력 — 실제 키 유출 탐지는 `--secret-env`에 `MINT_SIGNER_PRIVATE_KEY,RELAYER_SIGNER_PRIVATE_KEY,AMOY_DEPLOYER_PRIVATE_KEY,RAW_TX_ENCRYPTION_KEY,APPROVAL_JWT_SECRET,HMAC_*_KEY_SECRET`를 넘겨 정확 일치로. 로그(dump 아님) 스캔 시 `--strict`로 advisory도 gating |
| `npm run smoke:build` | `server/dist/main.js` 산출 확인 (D9) |
| `npm run smoke:docker` | `server/Dockerfile` 빌드 → 컨테이너 기동 → `/health`·`/ready` 확인. `.env`와 `SMOKE_DATABASE_URL`/`SMOKE_RPC_URL`/`SMOKE_NETWORK`(기본 host.docker.internal의 MySQL·Hardhat, `localhost` 네트워크) 사용 |
| `npm run fill-nonce-gap --workspace=server -- --signer relayer [--dry-run]` | 운영자 승인 절차: signer nonce gap을 0-value self tx로 메우고 halt 해제 (D1 §10) |

### Remediation 요약 (docs/검증-종합-문제-원인-개선안.md)

- **D1** 제출 순서 `estimateGas·fee → nonce 예약 → 서명·SIGNED 저장 → broadcast`; 예약 후 커밋 전 실패는 RELEASED로 반환되어 다음 제출이 재사용(gap 자동 충전); broadcast 오류 분류(`rpc-error.ts`)·exponential backoff·`BROADCAST_MAX_RETRIES` 상한·`nonce too high` 시 signer circuit breaker(`signer_locks.halted_reason`)와 `SIGNER_NONCE_GAP` 실패 기록.
- **D2** Transfer는 현재 owner == 판매자 수탁 지갑일 때만 접수; 워커는 tx 없는 ONCHAIN_CONFIRMED를 만들지 않음(→ REVIEW_REQUIRED `OWNER_ALREADY_AT_DESTINATION`).
- **D3** Reentry/External-Resale 접수 전에 relayer 시점 `eth_call` dry-run으로 서명·nonce·deadline·owner·pause를 검증(403/409, RPC 장애는 503); `transition()`이 `reviewReason/failureCode`를 기록; 운영자 복구 `POST /internal/v1/audit/operations/{id}/resolve-review`.
- **D4/D5** DataSource `timezone: 'Z'`. **D6** 최종 확정/실패 시 raw tx ciphertext 폐기. **D7** receipt block/hash/status·confirmedAt 저장, blockHash 재조회 검증, `GET /operations/{id}`에 `txAttempts`·증거·알림 상태 노출. **D8** 외부 서명은 암호화 저장·해시 기록·제출 후 폐기. **D9** `tsconfig.build.json rootDir=src` → `dist/main.js`. **D10** 잘못된 key scope는 403 `HMAC_SCOPE_FORBIDDEN`. **D11** RPC 오류 로그는 `class/code: reason`만 기록(raw tx·payload redaction).
- `GET /internal/v1/nfts/{tokenId}`, Metadata 이미지 제한(strict base64·크기·magic byte), Wallet 응답(`provider=WEB3AUTH`, `providerAdapter`, `integrationReady`, `createdAt`), webhook payload를 `openapi.yaml#BlockchainEvent`와 일치.

### 2차 remediation (docs/verification/문제-정의-원인-분석-개선안.md)

- **문제 1** 모든 MySQL 연결을 세션 `time_zone = '+00:00'`로 고정(`DatabaseTimezoneEnforcer` + `enforce-utc-session-timezone.ts`) — `timezone: 'Z'`는 드라이버 파싱만 UTC로 바꿀 뿐 세션은 서버 기본값을 따르므로, KST 호스트에서 타임스탬프가 9시간 어긋나고 `LONG_PENDING` 오탐이 나던 문제 제거. `SignedAttemptRecoveryWorker`의 재시도 due 판정도 앱 `Date` 대신 `NOW(3)`로 통일(`nextBroadcastAt`는 `DATE_ADD(NOW(3), …)`로 기록) → nonce gap 후 signer 영구 halt 재발 방지.
- **문제 2** 통합 스펙마다 공유 자원(고정 Hardhat signer·MySQL)의 휘발성 테이블을 파일 실행 전 초기화(`test/integration/reset-db-between-files.ts`, `setupFilesAfterEnv`) → 한 스펙의 실패가 뒤 스펙을 signer halt로 연쇄 실패시키지 않음. `test:integration`은 UTC·KST MySQL에서 반복 실행해도 63/63.
- **문제 3** `deploy:localhost`(= `--network localhost`) 스크립트 추가 — README가 `deploy:local`에 `--network`를 중복 전달해 `HHE510`으로 실패하던 문제 수정.
- **OpenAPI 계약 테스트 공백** OpenAPI 명세를 저장소 안(`code/openapi.yaml`)으로 옮기고 `openapi-contract.e2e-spec.ts`가 그 파일을 읽도록 수정. 이전에는 비버전관리 `docs/openapi.yaml`을 찾다가 문서 재배치로 파일을 못 찾으면 **8개 테스트가 assertion 없이 통과**(silent skip)하던 상태였음 — 파일 부재 시 이제 suite가 실패한다. 명세는 실제 구현과 대조 검증됨(v1.1.0, 8/8 실질 통과).
- **민감정보 스캐너 오탐** `scan:sensitive`의 `POSSIBLE_KEY_32B`(0x+64hex)는 keccak256 해시와 형태가 같고 SQL dump는 컬럼 문맥을 잃어 `tx_hash`를 매번 키로 오탐 → advisory로 강등(출력엔 남되 exit code 미반영), `--strict`로 로그 스캔 시 재게이팅. 실제 키 유출은 `--secret-env` 정확 일치로 탐지.
- **NFT.Storage 폐기 → Filebase** 장기 보존 어댑터를 NFT.Storage(Classic pinning API 2024-06-30 폐기)에서 **Filebase**로 교체. 표준 IPFS Pinning Service API(`POST /pins`, Bearer). `NFT_STORAGE_TOKEN` → `FILEBASE_PIN_TOKEN`(+ `FILEBASE_PIN_ENDPOINT`, 기본 `https://api.filebase.io/v1/ipfs`). 보존은 여전히 best-effort(Mint 비차단).
  - 비동기 pin: `POST /pins`는 `202 queued`(접수≠저장). `name` 미전송(선택 필드, 재사용 시 409 name conflict). `preservation_status`는 `checkStatus(requestId)`가 `pinned` 확인 후에만 `PRESERVED` — `metadata_dependencies.preservation_request_id` + `reconcilePreservation()`(`prepare()` 말미·`GET /metadata/:id` 시).
  - 멱등성: 반복·동시 `prepare()`에서 이미 `PRESERVED`거나 제출 중인 CID는 재제출 안 함. `PENDING(id 없음)`/`FAILED`/stale `SUBMITTING`만 원자적 claim(→`SUBMITTING`) 후 1회 제출.

## 문서

- 구현 계획, 요구사항, 검증 계획, 개발 로그, AC 추적표 — 이 저장소 상위 `docs/` (비버전관리 영역)
- **`openapi.yaml`** (저장소 루트) — 내부 API 계약의 버전관리 원본. `openapi-contract.e2e-spec.ts`가 실제 응답을 이 파일로 검증한다. Backend 핸드오프용 사본이 `docs/`에 있을 수 있으나 이 파일이 정본이다.
- `.env.example` — 전체 환경변수 목록과 각 TASK별 설명
