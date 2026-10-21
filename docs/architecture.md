# 아키텍처 설계

## 1. 전체 구성

```
                 ┌──────────── 변환 워커 (큐 기반, 무거운 작업 격리) ────────────┐
[발신자 포털] ─▶ │ DWG/DXF → PDF · STEP/CATIA/NX/SW → glTF · Office → PDF      │
                 └──────────────────────────────┬───────────────────────────────┘
                                                ▼
                                       [패키저] 청크 단위 AES-256-GCM 암호화, 헤더 서명
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
          .drm 파일 전달 → [Electron 뷰어]                          [웹 뷰어] (파일은 서버에만 존재)
                     │ 기기 키 + 로그인                                      │ 로그인 + 세션
                     └──────────────▶ [라이선스 서버 (NestJS)] ◀─────────────┘
                                       정책 검사(수신자·기간·회수) · KMS · 감사 로그
```

모든 포맷을 패키징 시점에 웹 렌더링 가능한 중간 포맷(PDF, glTF)으로 변환합니다. 이로써 렌더러가 pdf.js와 three.js로 단순화되고, Electron 뷰어와 웹 뷰어가 동일한 렌더러 코드를 공유합니다. 원본 CAD 파일은 외부로 나가지 않습니다.

## 2. 포맷 변환 엔진

| 포맷 | 오픈소스 | 상용 | 판단 |
|---|---|---|---|
| DWG/DXF → PDF | LibreDWG (GPL, 최신 버전 품질 불안정) | ODA Drawings SDK / ODA File Converter | 상용 권장 |
| STEP/IGES → glTF | OpenCascade (LGPL) | CAD Exchanger, HOOPS Exchange | 오픈소스로 충분 |
| CATIA/NX/SolidWorks 네이티브 | 사실상 없음 | CAD Exchanger SDK, HOOPS Exchange | 상용 필수 (대안: 발신자가 STEP으로 내보내 업로드) |
| Office → PDF | LibreOffice headless | Aspose | LibreOffice로 시작 |

외부 클라우드 변환 서비스(예: Autodesk APS)는 고객 도면을 외부로 전송하므로 제외합니다.

## 3. 웹 뷰어 콘텐츠 전달 방식

| 방식 | 보안 | 품질·성능 | 적용 |
|---|---|---|---|
| 브라우저 WebCrypto 복호화 | 낮음 (키·평문이 JS 메모리에 노출) | 좋음 | 미사용 |
| 서버 복호화 후 벡터(PDF/glTF) 세션 스트리밍 | 중간 | 좋음 | 기본 |
| 서버 래스터 타일 렌더링 + 워터마크 합성 | 높음 | 확대 시 품질 저하, 서버 부하 | 고등급 문서 |

문서 보안등급 정책과 연계하여 전달 방식을 결정합니다.

## 4. Electron 보안 하드닝

전제: asar는 쉽게 추출 가능하므로 **클라이언트에 비밀을 두지 않습니다.**

| 위협 | 대응 |
|---|---|
| asar 추출·로직 분석 | 키는 서버의 단기 라이선스로만 수령. `@electron/fuses`로 asar 무결성, `runAsNode`·`--inspect` 비활성화 |
| 기기 키 탈취 | `safeStorage`(Windows DPAPI)로 기기 개인키 보호. 이후 TPM 연동 검토 |
| 화면 캡처 | `BrowserWindow.setContentProtection(true)` (`WDA_EXCLUDEFROMCAPTURE`) |
| 렌더러 평문 추출 | `contextIsolation`, `sandbox`, `nodeIntegration: false`, 운영 빌드 DevTools 차단. 복호화는 main 프로세스, 디스크 기록 금지 |
| 인쇄·저장·복사 | `webContents.print`·단축키 차단, pdf.js 다운로드·인쇄 UI 및 텍스트 선택 제거 |
| 아날로그 유출 | 차단 불가. 수신자·시각 가시 워터마크와 감사 로그로 추적 |

## 5. 핵심 프로토콜

| 요소 | 설계 |
|---|---|
| 컨테이너(.drm) | `magic + version + 헤더(JSON: docId, contentType, keyId, alg) + 서버 서명(Ed25519)` + 1MB 청크 단위 AES-256-GCM 본문. 헤더는 AAD로 바인딩, 마지막 청크 플래그로 절단 공격 방지 |
| 키 계층 | KMS 마스터키 → 파일별 CEK 봉투 암호화(Envelope Encryption). 온프레미스는 Vault Transit, 클라우드는 AWS KMS |
| 라이선스 | 뷰어가 기기 키쌍(X25519) 등록. 열람 시 서버가 수신자·기간·회수 검사 후 CEK를 기기 공개키로 래핑(ECDH-ES + AES-KW)한 단기 서명 라이선스(만료, 권한, 워터마크 문구) 발급 |
| 인증 | 수신자 이메일 OTP로 시작, 필요 시 MFA. 계정당 기기 수 제한 |
| 오프라인 | 기본 온라인 필수. 정책 허용 시에만 유예 기간(예: 24시간) |

## 6. 저장소 구조 (pnpm workspace + Turborepo)

```
drm_1021/
├─ apps/
│  ├─ server/          # NestJS: 인증, 정책, 라이선스, 감사 로그
│  ├─ worker/          # BullMQ 워커: 변환·패키징 (LibreOffice, OCCT, ODA CLI 호출)
│  ├─ portal/          # 발신자 포털 (React)
│  ├─ viewer-desktop/  # Electron 뷰어
│  └─ viewer-web/      # 웹 뷰어 (React)
└─ packages/
   ├─ container/       # .drm 포맷 읽기·쓰기 (Node·브라우저 공용)
   ├─ crypto/          # 청크 AEAD, 키 래핑, 서명
   ├─ renderer/        # pdf.js + three.js 뷰어 컴포넌트 (데스크톱·웹 공용)
   └─ contracts/       # API DTO, 라이선스 스키마 (zod)
```

DB는 PostgreSQL, 큐는 Redis(BullMQ). 변환 워커는 네이티브 바이너리 의존성으로 인해 Docker 이미지로 격리합니다.

## 7. 미결정 사항

| 항목 | 영향 | 결정 시점 |
|---|---|---|
| ODA 등 상용 SDK 예산 | DWG 변환 품질 | 2단계 착수 전 |
| 배포 환경(온프레미스/클라우드) | KMS 선택 | 2단계 착수 전 |
