# 인증·라이선스 API 스펙 v1

| 항목 | 내용 |
|---|---|
| 상태 | Draft — 🔒 사람 리뷰 필요 (T0-06) |
| 구현 | `apps/server`, `apps/viewer-desktop`, `packages/crypto` |
| 스키마 | `@drm/contracts` |

## 1. 공통

* 기본 경로: `/api/v1`, JSON(UTF-8), TLS 1.2 이상
* 인증: `Authorization: Bearer <accessToken>`
* 모든 응답에 `X-Correlation-Id` 헤더. 요청에 있으면 그대로 사용, 없으면 서버가 생성
* 오류 응답은 `ApiErrorSchema` 형식

### 1.1 HTTP 상태 코드 매핑

| HTTP | 코드 |
|---|---|
| 400 | `VALIDATION_FAILED`, `OTP_INVALID`, `OTP_EXPIRED` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN`, 열람 거부 사유(`DenyReason` 전체) |
| 404 | `NOT_FOUND` |
| 409 | `CONFLICT`, `DEVICE_LIMIT_EXCEEDED` |
| 429 | `RATE_LIMITED`, `OTP_ATTEMPTS_EXCEEDED` |
| 500 | `INTERNAL_ERROR` (상세 원인은 로그에만 기록) |

## 2. 토큰

| 대상 | accessToken | refreshToken | 클레임 |
|---|---|---|---|
| 발신자 | 15분 | 8시간 | `sub`=userId, `typ`="sender" |
| 수신자 | 15분 | 7일 | `sub`=recipientId, `typ`="recipient" |

* accessToken: JWT, 서버 비밀키 서명. `typ`이 맞지 않는 토큰으로 다른 영역 API를 호출하면 401.
* refreshToken: 무작위 256비트 불투명 토큰. DB에는 SHA-256 해시만 저장. 사용 시 회전(rotation)하고, 이미 사용된 토큰이 재사용되면 해당 계열 전체를 폐기한다.

## 3. 엔드포인트

### 3.1 발신자

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/auth/login` | `SenderLoginRequest` | `TokenResponse` |
| POST | `/auth/refresh` | `RefreshTokenRequest` | `TokenResponse` |
| POST | `/distributions` | `CreateDistributionRequest` | 201 `Distribution` |
| GET | `/distributions` | `?page&size` | `DistributionSummary[]` |
| GET | `/distributions/:id` | — | `Distribution` |
| PATCH | `/distributions/:id` | `UpdateDistributionRequest` | `Distribution` |
| POST | `/distributions/:id/revoke` | — | `Distribution` |
| POST | `/distributions/:id/recipients/:recipientId/revoke` | — | `Distribution` |
| POST | `/distributions/:id/documents` | `multipart/form-data` (`file`) | 202 `Document` |
| POST | `/documents/:docId/revoke` | — | `Document` |

* 발신자는 자신이 만든 배포 건만 조회·수정할 수 있다(그 외 404).
* 모든 변경은 감사 이벤트를 남긴다.

### 3.2 수신자 인증

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/recipient-auth/otp/request` | `OtpRequest` | 항상 202 (본문 없음) |
| POST | `/recipient-auth/otp/verify` | `OtpVerifyRequest` | `TokenResponse` |
| POST | `/recipient-auth/refresh` | `RefreshTokenRequest` | `TokenResponse` |

**OTP 규칙**

* 6자리 숫자, `crypto.randomInt`로 생성. 유효 5분, 1회용.
* 저장은 `HMAC-SHA256(OTP_PEPPER, email ‖ 0x00 ‖ code)`만. 평문 저장 금지. 비교는 `timingSafeEqual`.
* OTP 하나당 검증 시도 5회. 초과 시 해당 OTP 폐기, `OTP_ATTEMPTS_EXCEEDED`.
* 새 OTP를 발급하면 이전 OTP는 무효.
* **계정 존재 여부를 노출하지 않는다:** 요청은 항상 202. 실제 메일은 이메일이 유효한(회수되지 않은) 배포 건의 수신자일 때만 보낸다.
* 발급 한도: 이메일당 시간당 5회, IP당 시간당 20회 (초과 시에도 202, 메일 미발송, 감사 로그 기록).

### 3.3 기기

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| POST | `/devices` | `RegisterDeviceRequest` | 201 `RegisterDeviceResponse` |

* 수신자 토큰 필요. 기기 공개키는 X25519 raw 32바이트.
* 활성 기기 수가 수신자의 배포 건 정책 중 **가장 작은** `maxDevices` 이상이면 409 `DEVICE_LIMIT_EXCEEDED`.
* 같은 공개키 재등록은 기존 `deviceId`를 반환(멱등).

### 3.4 문서 다운로드·라이선스

| 메서드 | 경로 | 요청 | 응답 |
|---|---|---|---|
| GET | `/recipient/documents` | — | `RecipientDocument[]` (지금 열람 가능한 문서) |
| GET | `/recipient/documents/:docId/package` | — | `application/octet-stream` (.drm) |
| POST | `/licenses` | `LicenseRequest` | 200 `SignedLicense` / 403 `ApiError` |

* `.drm` 다운로드와 문서 목록도 정책 엔진을 통과해야 한다(기기 조건 제외).
* 안내 메일에는 다운로드 링크를 넣지 않는다. 수신자는 뷰어에서 OTP로 로그인한 뒤 목록에서 내려받는다.
* 라이선스 거부 응답은 `code`에 거부 사유, `contact`에 발신자 이름·이메일을 담는다.
* 라이선스 발급 한도: 수신자당 분당 60회.

## 4. 열람 허용 판정 (정책 엔진)

입력은 모두 서버가 조회한 값이며 판정 시각은 **서버 시각**이다. 아래 순서로 검사하고 처음 걸린 사유를 반환한다.

| 순서 | 조건 | 거부 사유 |
|---|---|---|
| 1 | 수신자가 배포 건 목록에 없음 | `NOT_RECIPIENT` |
| 2 | 배포 건 회수됨 | `DISTRIBUTION_REVOKED` |
| 3 | 수신자 회수됨 | `RECIPIENT_REVOKED` |
| 4 | 문서 회수됨 | `DOCUMENT_REVOKED` |
| 5 | 문서 상태 ≠ `PACKAGED` | `DOCUMENT_NOT_READY` |
| 6 | `now < validFrom` | `NOT_YET_VALID` |
| 7 | `now ≥ validUntil` | `EXPIRED` |
| 8 | 기기 미등록 또는 다른 수신자의 기기 | `DEVICE_NOT_REGISTERED` |
| 9 | 기기 등록 해제됨 | `DEVICE_REVOKED` |
| 10 | `maxViews ≠ null` 이고 발급 횟수 ≥ `maxViews` | `VIEW_LIMIT_EXCEEDED` |

* 기간은 `[validFrom, validUntil)` 반개구간이다.
* 회수를 기간보다 먼저 검사한다. 만료 후 회수된 문서는 `…_REVOKED`로 안내한다.
* 다운로드 판정은 1~7만 적용한다.

## 5. 서명된 라이선스

```
payloadBytes = UTF-8(JSON(LicensePayload))
signature    = Ed25519-Sign(serverSigningKey[kid], ASCII "drm-1021:license:v1" ‖ 0x00 ‖ payloadBytes)
response     = { payload: base64url(payloadBytes), signature: base64url(signature), kid }
```

* `expiresAt = issuedAt + LICENSE_TTL_SECONDS(600초)`
* `watermark.text` = `<수신자 이메일> · <발급 시각 KST yyyy-MM-dd HH:mm> · <docId 앞 8자>`

## 6. CEK 래핑 (`X25519-HKDF-SHA256-A256KW`)

**서버 (발급)**

```
(ephPriv, ephPub) = X25519 키쌍 신규 생성 (라이선스마다)
shared  = X25519(ephPriv, devicePub)                  // 전부 0이면 거부
salt    = ephPub ‖ devicePub                          // 64바이트
info    = ASCII "drm-1021:license-kek:v1" ‖ 0x00 ‖ licenseId ‖ 0x00 ‖ docId   // UUID는 ASCII 문자열
KEK     = HKDF-SHA256(ikm = shared, salt, info, L = 32)
wrapped = AES-256-KW(KEK, CEK)                        // RFC 3394, 기본 IV, 40바이트
```

**뷰어 (수신)**

```
shared = X25519(devicePriv, ephPub) → 같은 HKDF로 KEK 계산 → AES-256-KW 언래핑
```

* `info`에 `licenseId`와 `docId`를 넣어 래핑 키를 해당 라이선스·문서에 묶는다.
* AES-KW 무결성 검사 실패 시 열람을 중단한다.
* 서버의 CEK 평문은 KMS 언래핑 직후 래핑에만 쓰고 즉시 버퍼를 0으로 덮는다.

## 7. 뷰어 검증 순서

1. `kid`가 내장 공개키 목록에 있는지 확인
2. 서명 검증 (도메인 분리 문자열 포함)
3. `payload` 디코딩 → `LicensePayloadSchema` 검증
4. `deviceId`가 자기 기기, `docId`가 열려는 `.drm` 헤더의 `docId`와 일치하는지 확인
5. CEK 언래핑 → `.drm` 복호화 (메모리에서만)
6. `expiresAt` 1분 전에 재발급 요청. 재발급이 거부되면 거부 사유를 표시하고 **문서를 닫고 평문·CEK를 폐기**한다.

> 6번의 로컬 시각 사용은 재발급 시점을 정하기 위한 것일 뿐, 열람 허용 판정이 아니다. 판정은 항상 서버가 한다. 따라서 회수가 반영되기까지 최대 지연은 라이선스 수명(10분)이다.

## 8. 감사 이벤트

| API | 이벤트 |
|---|---|
| `/auth/login` | `SENDER_LOGIN_SUCCEEDED` / `SENDER_LOGIN_FAILED` |
| `/recipient-auth/otp/request` | `OTP_REQUESTED` (한도 초과·미등록 포함, `detail.sent` 로 발송 여부) |
| `/recipient-auth/otp/verify` | `OTP_VERIFIED` / `OTP_FAILED` |
| `/devices` | `DEVICE_REGISTERED` |
| `/licenses` | `LICENSE_ISSUED` / `LICENSE_DENIED` (`detail.reason`) |
| `/recipient/documents/:docId/package` | `DOCUMENT_DOWNLOADED` / `DOCUMENT_DOWNLOAD_DENIED` (`detail.reason`) |
| 배포·문서 변경 | `DISTRIBUTION_*`, `RECIPIENT_*`, `DOCUMENT_*` |

`detail`에 키, OTP, 비밀번호, 토큰, 문서 본문을 넣지 않는다.
