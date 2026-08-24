import { App } from 'aws-cdk-lib/core';
import {
  buildGithubOidcSubject,
  GITHUB_OIDC_DOMAIN,
  GITHUB_REPOS,
  loadCicdConfig,
} from '../../lib/cicd/config';
import { buildCicdApp } from '../helpers';

/**
 * `loadCicdConfig` 는 CDK 리소스를 만들지 않는 순수 context 파싱이므로 `new App()` 으로
 * 입력만 구성해 일반 단위 테스트로 검증한다 (AGENTS.md 7장의 명시적 예외).
 */
describe('loadCicdConfig', () => {
  const load = (context: Record<string, unknown> = {}) =>
    loadCicdConfig(new App({ context }));

  test('키를 주지 않으면 undefined 다 (공급자를 새로 만드는 기본 경로)', () => {
    expect(load().githubOidcProviderArn).toBeUndefined();
  });

  test('공백만 있으면 undefined 로 정규화한다', () => {
    expect(
      load({ githubOidcProviderArn: '   ' }).githubOidcProviderArn,
    ).toBeUndefined();
  });

  test('정상 ARN 은 앞뒤 공백을 잘라 그대로 돌려준다', () => {
    const arn = `arn:aws:iam::111111111111:oidc-provider/${GITHUB_OIDC_DOMAIN}`;
    expect(
      load({ githubOidcProviderArn: ` ${arn} ` }).githubOidcProviderArn,
    ).toEqual(arn);
  });

  // 조용히 흘려보내면 신뢰 정책의 Federated 주체가 존재하지 않는 ARN 이 되고,
  // CloudFormation 은 IAM 주체 ARN 의 실존을 검증하지 않으므로 배포는 성공한 뒤
  // GitHub Actions 만 AssumeRole 에서 죽는다.
  test('ARN 형식이 아니면 즉시 던진다', () => {
    expect(() => load({ githubOidcProviderArn: 'not-an-arn' })).toThrow(
      /githubOidcProviderArn/,
    );
  });

  test('다른 발급자의 공급자면 즉시 던진다', () => {
    expect(() =>
      load({
        githubOidcProviderArn:
          'arn:aws:iam::111111111111:oidc-provider/accounts.google.com',
      }),
    ).toThrow(/githubOidcProviderArn/);
  });

  // 잘못된 값이 CLI 로 들어왔을 때 합성 자체가 멈추는지 확인한다.
  test('잘못된 값은 스택 합성 단계에서 멈춘다', () => {
    expect(() => buildCicdApp({ githubOidcProviderArn: 'oops' })).toThrow();
  });
});

describe('buildGithubOidcSubject', () => {
  test.each([
    [
      GITHUB_REPOS.pipeline,
      'develop',
      'repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/develop',
    ],
    [
      GITHUB_REPOS.pipeline,
      'main',
      'repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/main',
    ],
    [
      GITHUB_REPOS.dashboard,
      'develop',
      'repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/develop',
    ],
    [
      GITHUB_REPOS.dashboard,
      'main',
      'repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/main',
    ],
  ])(
    '저장소 ID와 브랜치를 포함한 immutable subject를 만든다',
    (repo, branch, expected) => {
      expect(buildGithubOidcSubject(repo, branch)).toEqual(expected);
    },
  );
});
