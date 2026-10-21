# .drm 컨테이너 포맷 스펙 v1

| 항목 | 내용 |
|---|---|
| 상태 | Draft — 🔒 사람 리뷰 필요 (T0-06) |
| 구현 | `packages/container`, `packages/crypto` |
| 스키마 | `@drm/contracts` `ContainerHeaderSchema` |

## 1. 목표

* 문서 본문을 문서별 무작위 키(CEK)로 암호화한다. CEK는 파일에 넣지 않는다.
* 헤더 위변조, 청크 순서 변경·삭제·복제, 파일 절단, 꼬리 데이터 추가를 모두 탐지한다.
* 대용량 파일을 전체 메모리 적재 없이 스트리밍으로 암·복호화한다.

## 2. 바이너리 레이아웃

모든 정수는 **빅엔디언(BE)**입니다.

```
offset        크기       필드
──────────────────────────────────────────────────────────────
0             4          magic        ASCII "DRM1" (0x44 0x52 0x4D 0x31)
4             2          version      uint16 = 1
6             4          headerLen    uint32, 1 ≤ H ≤ 65536
10            H          header       UTF-8 JSON (ContainerHeaderSchema)
──────────────────────────────────────────────────────────────  ← 여기까지 = prefix (10 + H 바이트)
10+H          2          sigLen       uint16 = 64
12+H          64         signature    Ed25519 서명 (§4)
76+H          ...        body         청크 0 … 청크 N-1 (§3)
```

### 2.1 헤더 필드

| 필드 | 타입 | 설명 |
|---|---|---|
| `v` | 1 | 포맷 버전. 바이너리 `version`과 같아야 한다. |
| `docId` | UUID | 문서 식별자. 서버는 이 값으로 CEK를 찾는다. |
| `alg` | `"AES-256-GCM-STREAM"` | 본문 암호화 방식 |
| `contentType` | `application/pdf` \| `model/gltf-binary` | 복호화된 콘텐츠(중간 포맷)의 MIME |
| `chunkSize` | 정수 | 평문 청크 크기. 4 KiB ~ 16 MiB, 기본 1 MiB |
| `plaintextSize` | 정수 | 평문 전체 크기(바이트) |
| `noncePrefix` | base64url, 7바이트 | 파일마다 무작위 생성 |
| `kid` | 문자열 | 헤더 서명 키 식별자 |
| `createdAt` | ISO 8601 UTC | 패키징 시각 |

헤더 JSON은 작성된 바이트 그대로 서명·AAD에 사용하므로 **재직렬화하지 않는다**. 리더는 바이트를 보존한 채로 파싱만 한다.

## 3. 본문 암호화 (AES-256-GCM STREAM)

### 3.1 청크 분할

* 청크 개수 `N = max(1, ceil(plaintextSize / chunkSize))`
* 청크 `i`(0 ≤ i < N-1)의 평문 길이 = `chunkSize`
* 마지막 청크(i = N-1)의 평문 길이 = `plaintextSize - (N-1) × chunkSize` (빈 파일이면 0)
* `N < 2^32`이어야 한다.

### 3.2 청크 암호화

```
nonce_i      = noncePrefix (7) ‖ uint32BE(i) (4) ‖ lastFlag (1)     // 총 12바이트
               lastFlag = 0x01 (i = N-1), 0x00 (그 외)
aad          = SHA-256(prefix)                                       // 32바이트, prefix = 바이트 [0, 10+H)
ciphertext_i = AES-256-GCM-Encrypt(CEK, nonce_i, plaintext_i, aad) ‖ tag_i (16)
```

* 본문은 `ciphertext_0 ‖ … ‖ ciphertext_{N-1}`이며 청크별 길이 필드는 없다. 길이는 3.1로 결정된다.
* 파일 전체 크기 = `76 + H + plaintextSize + 16 × N`

### 3.3 보안 성질

| 공격 | 탐지 방법 |
|---|---|
| 헤더 변조 | Ed25519 서명 실패 (§4). 서명을 우회해도 AAD 불일치로 모든 청크 복호화 실패 |
| 청크 순서 변경·복제 | 논스에 청크 인덱스 포함 → 태그 검증 실패 |
| 파일 절단 | 마지막 청크 플래그 불일치 또는 크기 불일치 |
| 꼬리 데이터 추가 | 전체 크기 불일치 → 거부 |
| 다른 파일과 청크 교체 | CEK·noncePrefix·AAD가 파일마다 다름 → 태그 검증 실패 |

### 3.4 키와 논스 규칙

* CEK는 문서마다 `crypto.randomBytes(32)`로 새로 만든다. **CEK를 두 문서에 재사용하지 않는다.**
* CEK가 문서마다 유일하므로 `(CEK, nonce)` 쌍의 유일성은 청크 인덱스로 보장된다. `noncePrefix` 무작위화는 심층 방어용이다.
* 같은 문서를 다시 패키징할 때도 CEK와 noncePrefix를 새로 만든다.

## 4. 헤더 서명

```
message   = ASCII "drm-1021:container-header:v1" ‖ 0x00 ‖ prefix
signature = Ed25519-Sign(serverSigningKey[kid], message)
```

* 도메인 분리 문자열로 라이선스 서명(`license-api.md` §5)과 혼용을 막는다.
* 서명 키는 서버만 보유한다. 뷰어는 빌드 시 내장한 `kid → 공개키` 목록으로 검증한다.

## 5. 리더 검증 순서

리더는 아래 순서를 지키며, 어느 단계든 실패하면 **평문을 하나도 반환하지 않고** 오류로 종료한다(마지막 청크 이전에 반환한 평문은 호출자가 폐기해야 한다는 의미에서 7번 참고).

1. `magic == "DRM1"`, `version == 1`
2. `1 ≤ headerLen ≤ 65536`
3. 헤더 UTF-8 디코딩 → JSON 파싱 → `ContainerHeaderSchema` 검증, `header.v == version`
4. `sigLen == 64`, `kid`에 해당하는 공개키로 서명 검증
5. 파일 크기를 알 수 있으면 §3.2 전체 크기 공식과 비교
6. 청크를 순서대로 복호화. 각 청크는 태그 검증 후에만 평문을 내보낸다.
7. 마지막 청크(lastFlag = 0x01) 처리 후 남은 바이트가 있으면 오류. 스트림이 마지막 청크 전에 끝나도 오류. **스트리밍 소비자는 최종 성공 신호를 받기 전까지 평문을 확정된 문서로 취급하지 않는다.**

## 6. 오류 코드 (`packages/container`)

| 코드 | 의미 |
|---|---|
| `INVALID_MAGIC` | DRM 파일이 아님 |
| `UNSUPPORTED_VERSION` | 지원하지 않는 버전 |
| `INVALID_HEADER` | 헤더 길이·JSON·스키마 오류 |
| `UNKNOWN_KEY_ID` | 서명 키를 찾을 수 없음 |
| `INVALID_SIGNATURE` | 헤더 서명 검증 실패 |
| `TRUNCATED` | 파일이 예상보다 짧음 |
| `TRAILING_DATA` | 파일이 예상보다 김 |
| `DECRYPTION_FAILED` | 청크 태그 검증 실패 (키 불일치 또는 변조) |

오류 메시지에 키, 평문, 논스 값을 포함하지 않는다.

## 7. 버전 정책

* 바이너리 `version`과 헤더 `v`를 함께 올린다.
* 리더는 알지 못하는 버전을 거부한다(하위 버전만 지원).
* 알고리즘 변경(예: 청크 AEAD 교체)은 반드시 버전 변경으로 처리한다.
