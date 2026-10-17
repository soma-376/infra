import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { fromContainerMetadata } from '@aws-sdk/credential-providers';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const quietLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };

/** 기본 credential chain으로 폴백하지 않고 ECS task role만 사용한다. */
export function createSecretReader(region, testing = {}) {
  const client = new SecretsManagerClient({
    region,
    // CLI는 testing 인자를 전달하지 않는다. 테스트만 메모리 credential과 HTTP adapter를 주입한다.
    credentials: testing.credentials ?? fromContainerMetadata({ timeout: 1_000, maxRetries: 0 }),
    maxAttempts: 3,
    retryMode: 'standard',
    requestHandler: testing.requestHandler ?? new NodeHttpHandler({
      connectionTimeout: 2_000,
      requestTimeout: 5_000,
      // 이 SDK 버전의 기본값은 경고뿐이므로 명시적으로 요청을 실패시킨다.
      throwOnRequestTimeout: true,
      logger: quietLogger,
    }),
    // SDK 예외 원문·HTTP 응답·값은 로그에 전달하지 않는다.
    logger: quietLogger,
  });
  return {
    fetchSecret: (input, options) => client.send(new GetSecretValueCommand(input), options),
    destroy: () => client.destroy(),
  };
}
