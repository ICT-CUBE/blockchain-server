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
- `metadata` — Pinata/NFT.Storage pinning/preservation (fake/real 어댑터)
- `audit` — 감사/실패 기록(`AuditWriter`), 운영자 조회 API

모든 외부 연동(Web3Auth, Pinata, NFT.Storage)은 `provider=fake|real` 환경변수로 전환되는 어댑터 포트 패턴을 따른다 — `fake`는 credential 없이 전체 파이프라인을 로컬에서 실행 가능하게 하는 결정적(deterministic) 구현이다.

## 요구 사항

- Node.js `24.x` (`.nvmrc` 참고)
- MySQL 8 (`docker-compose.yml`이 로컬용 인스턴스를 제공)
- Amoy/Mainnet 배포 시: Infura 등 RPC 엔드포인트, 자금이 있는 배포자 지갑

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
npm run node --workspace=contracts/cube-nft                                  # 별도 터미널: Hardhat 노드
npm run deploy:local --workspace=contracts/cube-nft -- --network localhost   # 배포
npm run start:dev --workspace=server                                         # 서버 기동
```

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
| `npm run scan:sensitive -- <file|dir>... [--secret-env HMAC_INBOUND_KEY_SECRET,...]` | 로그·DB dump에서 signed raw tx(typed/legacy)·65B 서명·키 형태·RPC payload echo·JWT·secret 리터럴 검사, 발견 시 exit 1 |
| `npm run smoke:build` | `server/dist/main.js` 산출 확인 (D9) |
| `npm run smoke:docker` | `server/Dockerfile` 빌드 → 컨테이너 기동 → `/health`·`/ready` 확인. `.env`와 `SMOKE_DATABASE_URL`/`SMOKE_RPC_URL`/`SMOKE_NETWORK`(기본 host.docker.internal의 MySQL·Hardhat, `localhost` 네트워크) 사용 |
| `npm run fill-nonce-gap --workspace=server -- --signer relayer [--dry-run]` | 운영자 승인 절차: signer nonce gap을 0-value self tx로 메우고 halt 해제 (D1 §10) |

### Remediation 요약 (docs/검증-종합-문제-원인-개선안.md)

- **D1** 제출 순서 `estimateGas·fee → nonce 예약 → 서명·SIGNED 저장 → broadcast`; 예약 후 커밋 전 실패는 RELEASED로 반환되어 다음 제출이 재사용(gap 자동 충전); broadcast 오류 분류(`rpc-error.ts`)·exponential backoff·`BROADCAST_MAX_RETRIES` 상한·`nonce too high` 시 signer circuit breaker(`signer_locks.halted_reason`)와 `SIGNER_NONCE_GAP` 실패 기록.
- **D2** Transfer는 현재 owner == 판매자 수탁 지갑일 때만 접수; 워커는 tx 없는 ONCHAIN_CONFIRMED를 만들지 않음(→ REVIEW_REQUIRED `OWNER_ALREADY_AT_DESTINATION`).
- **D3** Reentry/External-Resale 접수 전에 relayer 시점 `eth_call` dry-run으로 서명·nonce·deadline·owner·pause를 검증(403/409, RPC 장애는 503); `transition()`이 `reviewReason/failureCode`를 기록; 운영자 복구 `POST /internal/v1/audit/operations/{id}/resolve-review`.
- **D4/D5** DataSource `timezone: 'Z'`. **D6** 최종 확정/실패 시 raw tx ciphertext 폐기. **D7** receipt block/hash/status·confirmedAt 저장, blockHash 재조회 검증, `GET /operations/{id}`에 `txAttempts`·증거·알림 상태 노출. **D8** 외부 서명은 암호화 저장·해시 기록·제출 후 폐기. **D9** `tsconfig.build.json rootDir=src` → `dist/main.js`. **D10** 잘못된 key scope는 403 `HMAC_SCOPE_FORBIDDEN`. **D11** RPC 오류 로그는 `class/code: reason`만 기록(raw tx·payload redaction).
- `GET /internal/v1/nfts/{tokenId}`, Metadata 이미지 제한(strict base64·크기·magic byte), Wallet 응답(`provider=WEB3AUTH`, `providerAdapter`, `integrationReady`, `createdAt`), webhook payload를 `docs/openapi.yaml#BlockchainEvent`와 일치.

## 문서

- 구현 계획, 요구사항, 검증 계획, 개발 로그, AC 추적표 — 이 저장소 상위 `docs/` (비버전관리 영역)
- `.env.example` — 전체 환경변수 목록과 각 TASK별 설명
