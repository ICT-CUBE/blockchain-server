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

## 문서

- 구현 계획, 요구사항, 검증 계획, 개발 로그, AC 추적표 — 이 저장소 상위 `docs/` (비버전관리 영역)
- `.env.example` — 전체 환경변수 목록과 각 TASK별 설명
