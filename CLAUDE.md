# CLAUDE.md — drm_1021 프로젝트 규칙

외부 배포 문서 DRM. 요구사항은 `docs/prd.md`, 설계는 `docs/architecture.md`, 포맷·API 스펙은 `docs/specs/`가 기준입니다. 스펙과 코드가 다르면 코드를 고치지 말고 먼저 알립니다.

## 작업 방식

* 작업은 `docs/prd.md` 14장의 작업 ID(T0-01 등) 단위로 진행하고, 작업 하나당 커밋 하나를 만듭니다.
* 커밋 메시지: `<type>(<작업 ID>): <한국어 요약>` — type은 `feat`, `fix`, `chore`, `docs`, `test`, `refactor`
* 완료 판정은 해당 작업의 "완료 기준" 명령이 실제로 통과했는지로 합니다. 실패하면 그대로 보고합니다.
* 🔒 작업(보안 핵심)은 커밋 후 사람 리뷰 대상으로 보고합니다.

## 명령어

| 목적 | 명령 |
|---|---|
| 의존성 설치 | `pnpm install` |
| 전체 빌드 | `pnpm build` |
| 전체 타입 검사 | `pnpm typecheck` |
| 전체 테스트 | `pnpm test` |
| 특정 패키지 테스트 | `pnpm turbo run test --filter=@drm/<패키지>` (의존 패키지를 먼저 빌드함. `pnpm --filter … test`는 의존 패키지 dist가 오래되면 실패) |
| 린트 / 포맷 | `pnpm lint` / `pnpm format` |
| 발신자 계정 생성 | `pnpm --filter @drm/server build` 후 `pnpm --filter @drm/server sender:create -- --email <이메일> --name <이름>` (비밀번호는 표준 입력) |
| 서버 테스트 | DB가 필요하므로 PowerShell에서 실행 (Bash 샌드박스는 로컬 포트 접속 불가) |
| 로컬 인프라 | `cp .env.example .env` 후 `docker compose up -d --wait` (PostgreSQL :55432, Redis :56379, Mailpit SMTP :51025 / UI :58025) |

## 구조

```
apps/       실행 앱 (server, worker, portal, viewer-desktop, viewer-web)
           worker: `pnpm --filter @drm/worker build && pnpm --filter @drm/worker start` (서버와 같은 .env 사용)
packages/   공용 라이브러리 (@drm/contracts, @drm/crypto, @drm/container, @drm/kms, @drm/db, @drm/storage, @drm/renderer)
docs/       PRD, 아키텍처, 스펙
```

* 패키지 간 공유 타입·스키마는 반드시 `@drm/contracts`에 정의합니다. 앱에서 같은 타입을 다시 정의하지 않습니다.
* DB 스키마·마이그레이션은 `packages/db/prisma`에 있습니다. 마이그레이션 생성: `cd packages/db && npx prisma migrate dev --name <이름>` (PowerShell)
* 라이브러리 패키지는 ESM(`"type": "module"`), `tsc`로 `dist/`에 빌드합니다. 상대 import에는 `.js` 확장자를 붙입니다.

## 코드 규칙

* TypeScript strict. `any` 금지(불가피하면 사유 주석).
* 주석은 한국어, 식별자는 영어.
* 테스트는 Vitest, 구현 파일 옆에 `*.test.ts`로 둡니다.
* 오류는 원인을 잃지 않도록 `cause`를 연결해 다시 던집니다. 빈 `catch` 금지.

## 보안 금지 사항

* **암호 알고리즘을 직접 구현하지 않습니다.** Node 내장 `crypto`(AES-256-GCM, X25519, Ed25519, HKDF, AES-KW)만 조합합니다.
* 같은 키로 논스를 재사용하지 않습니다. 논스 생성 규칙은 `docs/specs/container.md`를 따릅니다.
* 키, CEK, OTP, 비밀번호, 문서 본문을 로그·오류 메시지·감사 로그에 남기지 않습니다.
* 복호화된 평문을 디스크(임시 파일 포함)에 쓰지 않습니다.
* 열람 기간·수신자·회수 판정은 서버에서만 합니다. 클라이언트 시계로 판정하지 않습니다.
* 비밀값 비교는 `crypto.timingSafeEqual`을 사용합니다.
* 새 외부 의존성 추가 시 사유를 커밋 메시지에 남깁니다.

## 환경

* Windows 11 + PowerShell / Git Bash, Node.js 24, pnpm 10
* TypeScript는 6.0으로 고정 (typescript-eslint 지원 범위)
* 줄바꿈은 LF (`.gitattributes`로 강제)
