import { Template } from 'aws-cdk-lib/assertions';
import { ECR_NAMESPACE, ECR_REPOS } from '../../lib/common/config';
import {
  ECS_CLUSTER_NAMES,
  ECS_SERVICE_NAMES,
} from '../../lib/common/deploy-targets';
import {
  ECR_PUSH_ACTIONS,
  ECS_DEPLOY_ACTIONS,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_DOMAIN,
  GITHUB_OIDC_URL,
  GITHUB_REPOS,
} from '../../lib/cicd/config';
import { buildApp, buildCicdApp, buildDevApp } from '../helpers';

const PIPELINE_DEV = `github-deploy-${GITHUB_REPOS.pipeline.name}-dev`;
const PIPELINE_PROD = `github-deploy-${GITHUB_REPOS.pipeline.name}-prod`;
const DASHBOARD_DEV = `github-deploy-${GITHUB_REPOS.dashboard.name}-dev`;
const DASHBOARD_PROD = `github-deploy-${GITHUB_REPOS.dashboard.name}-prod`;
const ALL_ROLES = [PIPELINE_DEV, PIPELINE_PROD, DASHBOARD_DEV, DASHBOARD_PROD];

describe('DeployStack', () => {
  const { deploy } = buildCicdApp();
  const template = Template.fromStack(deploy);

  /**
   * ARN 값에서 리터럴 조각만 이어붙인다. `Arn.format` 은 계정 토큰 때문에 Fn::Join 을
   * 만든다. `test/dev/application-stack.test.ts` 의 `imageLiterals` 와 같은 기법이다.
   */
  const arnLiterals = (value: unknown): string =>
    typeof value === 'string'
      ? value
      : ((value as any)['Fn::Join'][1] as unknown[])
          .filter((part): part is string => typeof part === 'string')
          .join('');

  const roleResource = (roleName: string): [string, any] => {
    const found = Object.entries(template.findResources('AWS::IAM::Role')).find(
      ([, r]: [string, any]) => r.Properties.RoleName === roleName,
    );
    expect(found).toBeDefined();
    return found as [string, any];
  };

  const trustStatement = (roleName: string): any =>
    roleResource(roleName)[1].Properties.AssumeRolePolicyDocument.Statement[0];

  /**
   * 그 역할에 붙은 모든 인라인 정책의 statement.
   *
   * **statement 인덱스로 접근하지 않는다.** `@aws-cdk/aws-iam:minimizePolicies` 가 켜져
   * 있어 액션 집합이 같아지면 CDK 가 statement 를 병합할 수 있다. 어서션은 "액션 ->
   * 리소스" 매핑으로만 세운다.
   */
  const statementsFor = (roleName: string): any[] => {
    const [logicalId] = roleResource(roleName);
    return Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
      (policy: any) =>
        policy.Properties.Roles.some((r: any) => r.Ref === logicalId)
          ? policy.Properties.PolicyDocument.Statement
          : [],
    );
  };

  const asArray = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [value];

  const actionsFor = (roleName: string): string[] =>
    statementsFor(roleName).flatMap((s) => asArray(s.Action) as string[]);

  /** 그 역할이 만지는 모든 리소스 ARN 을 한 덩어리 문자열로. 부정 어서션용. */
  const resourceTextFor = (roleName: string): string =>
    statementsFor(roleName)
      .flatMap((s) => asArray(s.Resource).map(arnLiterals))
      .join('\n');

  const statementWithAction = (roleName: string, action: string): any => {
    const found = statementsFor(roleName).find((s) =>
      (asArray(s.Action) as string[]).includes(action),
    );
    expect(found).toBeDefined();
    return found;
  };

  const ecsServicePairsFor = (roleName: string): string[] =>
    statementsFor(roleName)
      .filter((s) =>
        (asArray(s.Action) as string[]).includes('ecs:UpdateService'),
      )
      .flatMap((s) => asArray(s.Resource).map(arnLiterals))
      .map((arn) => arn.split(':service/')[1]);

  // ============================================================
  // OIDC 공급자
  // ============================================================
  describe('GitHub OIDC 공급자', () => {
    test('공급자는 계정당 하나이므로 스택에도 하나만 만든다', () => {
      template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
      template.hasResourceProperties('AWS::IAM::OIDCProvider', {
        Url: GITHUB_OIDC_URL,
        ClientIdList: [GITHUB_OIDC_AUDIENCE],
      });
    });

    // 지문을 박아 두면 GitHub 이 인증서를 회전할 때 인프라는 멀쩡한 채 Actions 만 죽는다.
    // 생략하면 IAM 이 상위 중간 CA 지문을 직접 조회해 쓴다. (ADR-0024 3번)
    test('ThumbprintList 를 지정하지 않는다', () => {
      const [, provider] = Object.entries(
        template.findResources('AWS::IAM::OIDCProvider'),
      )[0] as [string, any];
      expect(provider.Properties.ThumbprintList).toBeUndefined();
    });

    // 계정 전역 신뢰 앵커라 스택을 지워도 남아야 한다.
    test('RETAIN 이라 스택 삭제로 사라지지 않는다', () => {
      template.hasResource('AWS::IAM::OIDCProvider', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });

    // 구형 OpenIdConnectProvider 로 회귀하면 Lambda + 실행 역할 + 에셋이 딸려온다.
    test('커스텀 리소스(Lambda)를 만들지 않는다', () => {
      template.resourceCountIs('AWS::Lambda::Function', 0);
      template.resourceCountIs('AWS::CloudFormation::CustomResource', 0);
    });

    test('githubOidcProviderArn 을 주면 만들지 않고 참조만 한다', () => {
      const existingArn =
        'arn:aws:iam::111111111111:oidc-provider/token.actions.githubusercontent.com';
      const imported = Template.fromStack(
        buildCicdApp({ githubOidcProviderArn: existingArn }).deploy,
      );

      imported.resourceCountIs('AWS::IAM::OIDCProvider', 0);
      imported.resourceCountIs('AWS::IAM::Role', 4);

      for (const role of Object.values(
        imported.findResources('AWS::IAM::Role'),
      ) as any[]) {
        expect(
          role.Properties.AssumeRolePolicyDocument.Statement[0].Principal
            .Federated,
        ).toEqual(existingArn);
      }
    });
  });

  // ============================================================
  // 신뢰 정책 - 배포 권한의 실질적 경계
  // ============================================================
  describe('신뢰 정책', () => {
    test('역할은 레포 × 환경 4개다', () => {
      template.resourceCountIs('AWS::IAM::Role', 4);
    });

    // 이름이 바뀌면 앱 레포 워크플로우의 role-to-assume 이 조용히 깨진다.
    test.each(ALL_ROLES)('%s 역할 이름이 고정되어 있다', (roleName) => {
      expect(roleResource(roleName)).toBeDefined();
    });

    test.each([
      [
        PIPELINE_DEV,
        'repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/develop',
      ],
      [
        PIPELINE_PROD,
        'repo:soma-376@297555253/ai-telemetry-pipeline@1309872274:ref:refs/heads/main',
      ],
      [
        DASHBOARD_DEV,
        'repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/develop',
      ],
      [
        DASHBOARD_PROD,
        'repo:soma-376@297555253/pulsemetry-backend@1325324450:ref:refs/heads/main',
      ],
    ])('%s 는 그 레포의 그 브랜치만 신뢰한다', (roleName, subject) => {
      const statement = trustStatement(roleName);

      expect(statement.Action).toEqual('sts:AssumeRoleWithWebIdentity');
      expect(statement.Condition.StringEquals).toEqual({
        [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
        [`${GITHUB_OIDC_DOMAIN}:sub`]: subject,
      });
    });

    // `StringLike` + `repo:org@org-id/repo@repo-id:*` 는 PR 헤드 브랜치와 태그를 포함한
    // **모든 ref** 에 이 역할을 연다. 그러면 develop -> dev / main -> prod 분리가 통째로
    // 사라진다. 이 스위트에서 가장 중요한 어서션 중 하나다. (ADR-0024 2번)
    test.each(ALL_ROLES)('%s 의 조건에 StringLike 가 없다', (roleName) => {
      const condition = trustStatement(roleName).Condition;
      expect(condition.StringLike).toBeUndefined();
      expect(Object.keys(condition)).toEqual(['StringEquals']);
    });
  });

  // ============================================================
  // 권한 - 이미지 push 와 강제 재배포 둘뿐
  // ============================================================
  describe('권한 정책', () => {
    // 이 액션은 리소스 수준 권한을 지원하지 않아 `*` 가 강제된다. 그래서 이 statement 에
    // 다른 액션이 얹히면 그 액션까지 계정 전역이 된다.
    test.each(ALL_ROLES)(
      '%s 의 `*` 리소스 statement 는 GetAuthorizationToken 하나뿐이다',
      (roleName) => {
        const statement = statementWithAction(
          roleName,
          'ecr:GetAuthorizationToken',
        );
        expect(asArray(statement.Action)).toEqual(['ecr:GetAuthorizationToken']);
        expect(statement.Resource).toEqual('*');

        const wildcardStatements = statementsFor(roleName).filter((s) =>
          asArray(s.Resource).includes('*'),
        );
        expect(wildcardStatements).toHaveLength(1);
      },
    );

    test.each(ALL_ROLES)('%s 의 ECR push 액션 집합이 정확하다', (roleName) => {
      const statement = statementWithAction(roleName, 'ecr:PutImage');
      expect((asArray(statement.Action) as string[]).sort()).toEqual(
        [...ECR_PUSH_ACTIONS].sort(),
      );
    });

    test.each(ALL_ROLES)(
      '%s 는 manifest push 용 BatchGetImage 만 ECR 레포 범위로 허용한다',
      (roleName) => {
        const batchGetStatement = statementWithAction(
          roleName,
          'ecr:BatchGetImage',
        );
        const putStatement = statementWithAction(roleName, 'ecr:PutImage');

        expect(batchGetStatement).toBe(putStatement);
        expect(asArray(batchGetStatement.Resource)).not.toContain('*');
        for (const resource of asArray(batchGetStatement.Resource)) {
          expect(arnLiterals(resource)).toContain(
            `:repository/${ECR_NAMESPACE}/`,
          );
        }
        expect(actionsFor(roleName)).not.toContain(
          'ecr:GetDownloadUrlForLayer',
        );
      },
    );

    test.each(ALL_ROLES)('%s 의 ECS 액션 집합이 정확하다', (roleName) => {
      const statement = statementWithAction(roleName, 'ecs:UpdateService');
      expect((asArray(statement.Action) as string[]).sort()).toEqual(
        [...ECS_DEPLOY_ACTIONS].sort(),
      );
    });

    // `--force-new-deployment` 는 기존 태스크 정의를 재사용하므로 이 셋이 필요 없다.
    // 넣는 순간 CI 가 태스크 정의를 갈아끼우고 임의 역할을 붙일 수 있게 된다. (ADR-0024 5번)
    test.each(ALL_ROLES)('%s 에 권한 상승 액션이 없다', (roleName) => {
      const actions = actionsFor(roleName);

      for (const forbidden of [
        'iam:PassRole',
        'ecs:RegisterTaskDefinition',
        'ecs:DescribeTaskDefinition',
        'ecs:ListServices',
      ]) {
        expect(actions).not.toContain(forbidden);
      }

      expect(actions.filter((a) => a.startsWith('iam:'))).toEqual([]);
      expect(actions.filter((a) => a.endsWith('*'))).toEqual([]);
    });
  });

  // ============================================================
  // 권한 경계 - 이 스위트의 핵심
  // ============================================================
  describe('권한 경계', () => {
    // dev 잡이 운영을 강제 재배포할 경로 자체가 없어야 한다. 역할을 환경별로 나눈 이유다.
    test.each([
      [PIPELINE_DEV, ECS_CLUSTER_NAMES.prod],
      [DASHBOARD_DEV, ECS_CLUSTER_NAMES.prod],
      [PIPELINE_PROD, ECS_CLUSTER_NAMES.dev],
      [DASHBOARD_PROD, ECS_CLUSTER_NAMES.dev],
    ])('%s 는 %s 클러스터를 건드릴 수 없다', (roleName, foreignCluster) => {
      expect(resourceTextFor(roleName)).not.toContain(foreignCluster);
    });

    // 한 팀이 다른 팀의 이미지를 밀 수 있으면 레포별로 나눈 의미가 없다.
    test.each([
      [
        PIPELINE_DEV,
        [
          ECR_REPOS.apiServer,
          ECR_REPOS.batchProcessor,
          ECR_REPOS.enrollmentApi,
          ECR_REPOS.telemetryIngest,
        ],
      ],
      [
        PIPELINE_PROD,
        [
          ECR_REPOS.apiServer,
          ECR_REPOS.batchProcessor,
          ECR_REPOS.enrollmentApi,
          ECR_REPOS.telemetryIngest,
        ],
      ],
      [DASHBOARD_DEV, [ECR_REPOS.postProcessor, ECR_REPOS.authProxy]],
      [DASHBOARD_PROD, [ECR_REPOS.postProcessor, ECR_REPOS.authProxy]],
    ])('%s 는 다른 레포의 ECR 레포를 건드릴 수 없다', (roleName, foreign) => {
      const text = resourceTextFor(roleName);
      for (const repo of foreign) {
        expect(text).not.toContain(`:repository/${repo}`);
      }
    });

    test('backend dev 역할은 기존 대상과 신규 배포 단위를 모두 허용한다', () => {
      const repositories = asArray(
        statementWithAction(DASHBOARD_DEV, 'ecr:PutImage').Resource,
      )
        .map(arnLiterals)
        .map((arn) => arn.split(':repository/')[1])
        .sort();
      const services = asArray(
        statementWithAction(DASHBOARD_DEV, 'ecs:UpdateService').Resource,
      )
        .map(arnLiterals)
        .map((arn) => arn.split(':service/')[1])
        .sort();

      expect(repositories).toEqual(
        [
          ECR_REPOS.apiServer,
          ECR_REPOS.batchProcessor,
          ECR_REPOS.enrollmentApi,
          ECR_REPOS.telemetryIngest,
        ].sort(),
      );
      expect(services).toEqual(
        [
          `${ECS_CLUSTER_NAMES.dev}/${ECS_SERVICE_NAMES.dashboard}`,
          `${ECS_CLUSTER_NAMES.dev}/${ECS_SERVICE_NAMES.enrollmentApi}`,
          `${ECS_CLUSTER_NAMES.dev}/${ECS_SERVICE_NAMES.telemetryIngest}`,
        ].sort(),
      );
    });

    test('backend prod 역할은 기존 대상만 유지한다', () => {
      const repositories = asArray(
        statementWithAction(DASHBOARD_PROD, 'ecr:PutImage').Resource,
      )
        .map(arnLiterals)
        .map((arn) => arn.split(':repository/')[1])
        .sort();
      const services = asArray(
        statementWithAction(DASHBOARD_PROD, 'ecs:UpdateService').Resource,
      )
        .map(arnLiterals)
        .map((arn) => arn.split(':service/')[1])
        .sort();

      expect(repositories).toEqual(
        [ECR_REPOS.apiServer, ECR_REPOS.batchProcessor].sort(),
      );
      expect(services).toEqual([
        `${ECS_CLUSTER_NAMES.prod}/${ECS_SERVICE_NAMES.dashboard}`,
      ]);
    });

    // 운영에는 auth-proxy 서비스가 아예 없다 (ADR-0023). 없는 서비스의 ARN 을 넣으면
    // AGENTS.md 3장이 금지하는 죽은 계약이 된다.
    test('prod 파이프라인 역할에 auth-proxy 가 전혀 없다', () => {
      expect(resourceTextFor(PIPELINE_PROD)).not.toContain(
        ECS_SERVICE_NAMES.authProxy,
      );
    });

    // ClickHouse 는 공개 이미지 고정 태그라 앱 레포가 재배포할 대상이 아니다 (ADR-0019).
    test.each(ALL_ROLES)('%s 에 clickhouse 서비스 ARN 이 없다', (roleName) => {
      expect(resourceTextFor(roleName)).not.toContain(
        `/${ECS_SERVICE_NAMES.clickhouse}`,
      );
    });
  });

  // ============================================================
  // 크로스 스택 - IAM 이 실재하는 이름을 가리키는가
  // ============================================================
  //
  // **이 티켓 최대의 위험을 막는 어서션이다.** CloudFormation 은 IAM 정책에 적힌 리소스
  // ARN 의 실존을 검증하지 않는다. `deploy-targets.ts` 를 고치면서 application-stack 한쪽만
  // 반영하면 네 스택이 전부 배포에 성공하고 GitHub Actions 만 AccessDenied 로 죽는다.
  describe('IAM 서비스 ARN 이 실제 스택의 이름과 일치한다', () => {
    const namePairs = (stackTemplate: Template): string[] => {
      const clusters = Object.values(
        stackTemplate.findResources('AWS::ECS::Cluster'),
      ) as any[];
      const services = Object.values(
        stackTemplate.findResources('AWS::ECS::Service'),
      ) as any[];

      return clusters.flatMap((cluster) =>
        services.map(
          (service) =>
            `${cluster.Properties.ClusterName}/${service.Properties.ServiceName}`,
        ),
      );
    };

    const deployed = [
      ...namePairs(Template.fromStack(buildApp().application)),
      ...namePairs(Template.fromStack(buildDevApp().application)),
    ];

    test.each(ALL_ROLES)(
      '%s 의 모든 ECS ARN 이 실제로 만들어지는 서비스다',
      (roleName) => {
        const servicePairs = ecsServicePairsFor(roleName);

        expect(servicePairs.length).toBeGreaterThan(0);
        for (const servicePair of servicePairs) {
          expect(deployed).toContain(servicePair);
        }
      },
    );
  });

  // 앱 레포에 넘겨줄 값. 논리 ID 가 바뀌면 핸드오프 문서가 낡는다.
  test('역할 ARN 4개를 CfnOutput 으로 내보낸다', () => {
    const outputs = template.findOutputs('*');
    expect(Object.keys(outputs).filter((k) => k.endsWith('Arn'))).toHaveLength(
      4,
    );
  });
});
