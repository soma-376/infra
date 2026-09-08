import { App } from 'aws-cdk-lib/core';
import { ECR_REPOS } from '../../lib/common/config';
import { ECS_SERVICE_NAMES } from '../../lib/common/deploy-targets';
import {
  buildGithubOidcSubject,
  DEPLOY_TARGETS,
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

describe('DEPLOY_TARGETS', () => {
  test('dev pipeline 역할 행은 유지하되 권한 대상은 둘 다 비어 있다', () => {
    expect(DEPLOY_TARGETS.dev[0]).toEqual({
      repo: GITHUB_REPOS.pipeline,
      ecrRepos: [],
      services: [],
    });
  });

  test('dev backend 역할은 신규 배포 단위 둘만 대상으로 삼는다', () => {
    expect(DEPLOY_TARGETS.dev[1]).toEqual({
      repo: GITHUB_REPOS.dashboard,
      ecrRepos: [ECR_REPOS.enrollmentApi, ECR_REPOS.telemetryIngest],
      services: [
        ECS_SERVICE_NAMES.enrollmentApi,
        ECS_SERVICE_NAMES.telemetryIngest,
      ],
    });
  });

  test('prod 역할 대상은 기존 계약을 그대로 유지한다', () => {
    expect(DEPLOY_TARGETS.prod).toEqual([
      {
        repo: GITHUB_REPOS.pipeline,
        ecrRepos: [ECR_REPOS.postProcessor],
        services: [ECS_SERVICE_NAMES.collector],
      },
      {
        repo: GITHUB_REPOS.dashboard,
        ecrRepos: [ECR_REPOS.apiServer, ECR_REPOS.batchProcessor],
        services: [ECS_SERVICE_NAMES.dashboard],
      },
    ]);
  });
});
