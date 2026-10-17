# dev ECS 사용자 JWT 키 writer

ADR-0030의 일회성 ECS 컨테이너다. 지정된 Secrets Manager 버전을 task role로 읽고
task별 공유 volume에 PEM 파일을 완성한 뒤 종료한다. 일반 기동에서 키를 생성하거나 Secret을
등록·변경하지 않는다. 이 프로그램의 실제 AWS 조회는 배포된 컨테이너의 runtime 작업이며,
로컬 검증은 주입한 메모리 응답만 사용한다.

`cli.mjs`가 읽는 입력은 `JWT_WRITER_CONFIG` JSON 하나다. PEM·자격 증명 원문은 입력에 넣지 않는다.

```json
{
  "region": "ap-northeast-2",
  "publicSecretArn": "arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:<PUBLIC_SECRET_NAME>-<SUFFIX>",
  "publicVersionId": "<PUBLIC_VERSION_ID>",
  "publicKeys": [
    { "kid": "release-2026-10", "alias": "public-0.pem" },
    { "kid": "previous-release", "alias": "public-1.pem" }
  ],
  "privateSecretArn": "arn:aws:secretsmanager:ap-northeast-2:<ACCOUNT_ID>:secret:<PRIVATE_SECRET_NAME>-<SUFFIX>",
  "privateVersionId": "<PRIVATE_VERSION_ID>",
  "activeKid": "release-2026-10"
}
```

위 예시의 마지막 세 필드는 enrollment signer 전용이다. dashboard에는 세 필드를 모두 생략한다.
VersionId는 AWS 형식의 32~64자 식별자이며 개인키·공개키 버전은 독립적이다.
`AWSCURRENT`·VersionStage를 조회 선택자로 사용하지 않는다. 공개키 원본은 정확한
`kid → X.509 PEM` 문자열 JSON이고 개인키 원본은 PKCS8 PEM이다. 조회 응답 ARN·VersionId가
요청과 다르거나 원본이 SecretBinary이면 실패한다.

`publicKeys`는 선택한 공개키 버전의 **전체 kid 집합과 정확히 일치**해야 한다. alias는 ASCII로 시작하는
안전한 `.pem` basename이며 kid와 독립적이다. 중복 kid·alias, `private.pem` alias, 경로 이탈,
빈 값·손상 PEM·RSA 2048bit 미달·RSA 이외 키를 거부한다. signer는 active kid의 공개키를
개인키에서 도출한 공개키와 대조하고 시험 서명/검증한다. 공개키 JSON의 중복 필드도 거부한다.

공유 volume root는 `/mnt/user-jwt`이고 최종 경로는 다음과 같다.

| 파일 | 앱 설정 |
|---|---|
| `/mnt/user-jwt/keys/<alias>` | 정확한 kid별 `public-key-files` 맵 |
| `/mnt/user-jwt/keys/private.pem` | enrollment `private-key-file` |

writer를 root로 시작해 디렉터리·파일의 UID/GID를 `10001:10001`로 설정한다.
root directory는 0755, `keys` directory는 0750, 키 파일은 0440이다. 별도 child process를
실제 UID/GID 10001로 실행해 읽기를 확인한 후, 같은 volume 안의 staging directory를 `keys`로
rename한다. 읽기·쓰기 실패는 앱 기동 성공으로 처리하지 않는다. root와 상위 경로의 symlink,
기존 `keys`, 다른 사용자가 쓸 수 있는 root를 거부한다. 앱은 writer `SUCCESS` 후 읽기 전용
mount를 사용해야 하며 writer는 `essential: false`여야 한다.

SDK는 `fromContainerMetadata`의 ECS task role만 사용하고 일반 credential chain으로 폴백하지 않는다.
연결 timeout은 2초, 요청 timeout은 5초, SDK 시도는 최대 3회다. `throwOnRequestTimeout: true`를
명시해 SDK가 timeout 경고만 남기고 계속 기다리지 않게 한다. 전체 writer deadline은 30초이며
조회·파일 검증·게시를 포함한다. deadline 이후 늦게 도착한 응답은 파일을 게시할 수 없다.
실패 시 stderr에 고정 코드 한 줄과 exit 1만 반환하고 SDK 예외·응답·원문·파일 경로는 출력하지 않는다.
성공 시 출력 없이 exit 0이다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

테스트는 테스트 프로세스 안에서 만든 RSA 키와 fake reader/HTTP adapter만 사용한다.
실제 Secret·AWS credential·`generated/` 파일은 읽지 않는다. 비root 호스트에서는 현재 UID/GID의
쓰기·읽기를 검증하고 root 전용 UID 10001 시험은 skip한다. SDK adapter 시험도 메모리 credential과
가짜 HTTP 응답을 주입하며 네트워크를 사용하지 않는다.

Docker base는 2026-10-17 Docker Hub의 Node 24 `bookworm-slim` ARM64 manifest를 확인해 고정했다.
Docker가 준비된 환경에서 다음과 같이 이미지와 128 MiB 제한을 로컬 검증한다.

```sh
docker build --platform linux/arm64 -t pulsemetry-jwt-key-writer:local .
docker run --rm --network none --platform linux/arm64 \
  --memory 128m --memory-reservation 64m \
  --mount "type=bind,source=$(pwd)/test,target=/app/test,readonly" \
  --entrypoint node pulsemetry-jwt-key-writer:local \
  --max-old-space-size=64 --test test/writer.test.mjs test/sdk.test.mjs
```

이 실행은 root 전용 child 읽기 시험까지 포함한다. 64 MiB soft reservation·128 MiB hard limit은
초기 검증값이며 실제 SDK 재시도·Spring 앱과의 동시 peak·EC2 host 여유·OOM·placement를
증명하지 않는다. 로컬 Docker daemon을 이용할 수 없으면 해당 결과를 미검증으로 기록한다.

배포는 CDK 밖에서 선생성한 `soma-376/` namespace의 ECR repository에 승인된 절차로 이미지를
공급한 뒤 immutable digest를 전달한다. 이 디렉터리는 ECR repository를 생성하거나
`DockerImageAsset`으로 CDK bootstrap repository에 publish하지 않는다. 이미지 push·AWS 배포·
실제 키 조회는 위 로컬 테스트 명령에 포함되지 않는다. Secret 원본의 버전 보존·회전·롤백과
task 종료 후 ECS volume 정리 및 host 잔존 확인은 ADR-0030과 배포 런북의 별도 관문이다.
