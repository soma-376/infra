import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib/core';
import { IOidcProvider, OpenIdConnectPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_DOMAIN, GITHUB_ORG } from './config';

/** 기존 앱 배포 역할과 분리한 infra 저장소의 dev CloudFormation 계약 (ADR-0048). */
export const INFRA_DEV_CICD = {
  repository: { name: 'infra', id: '1310491235' },
  region: 'ap-northeast-2',
  bootstrapQualifier: 'hnb659fds',
  stacks: ['DevNetworkStack', 'DevDataStack', 'DevEdgeStack', 'DevEksStack'],
  legacyStack: 'DevApplicationStack',
  diffEnvironments: ['infra-dev-pr-plan', 'infra-dev-plan'],
  deployEnvironment: 'infra-dev-deploy',
  diffRoleName: 'soma-376-infra-dev-diff',
  deployRoleName: 'soma-376-infra-dev-deploy',
} as const;

export interface InfraDevRoles {
  readonly diff: Role;
  readonly deploy: Role;
}

/**
 * 기존 provider를 공유하되 앱 역할의 trust·권한·output을 변경하지 않는다.
 * Environment subject에는 branch가 없으므로 GitHub의 reviewer·branch 보호가 필수다.
 */
export function createInfraDevRoles(scope: Construct, oidcProvider: IOidcProvider): InfraDevRoles {
  const stack = Stack.of(scope);
  const subject = (environment: string): string =>
    `repo:${GITHUB_ORG.name}@${GITHUB_ORG.id}/${INFRA_DEV_CICD.repository.name}@${INFRA_DEV_CICD.repository.id}:environment:${environment}`;

  // 이미 배포한 Description의 ADR-0044는 재번호 전 표기이며, 배포 차이를 피하려고 유지한다.
  const createRole = (id: string, roleName: string, environments: readonly string[]): Role => new Role(scope, id, {
    roleName,
    description: `GitHub Actions role for infra dev CloudFormation ${id === 'InfraDevDiffRole' ? 'read-only diff' : 'approved deployment'} (ADR-0044)`,
    maxSessionDuration: Duration.hours(1),
    assumedBy: new OpenIdConnectPrincipal(oidcProvider, {
      StringEquals: {
        [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
        [`${GITHUB_OIDC_DOMAIN}:sub`]: environments.map(subject),
      },
    }),
  });

  const diff = createRole('InfraDevDiffRole', INFRA_DEV_CICD.diffRoleName, INFRA_DEV_CICD.diffEnvironments);
  const deploy = createRole('InfraDevDeployRole', INFRA_DEV_CICD.deployRoleName, [INFRA_DEV_CICD.deployEnvironment]);
  const stackArn = (name: string): string => stack.formatArn({
    service: 'cloudformation',
    region: INFRA_DEV_CICD.region,
    resource: 'stack',
    resourceName: `${name}/*`,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
  const stackArns = INFRA_DEV_CICD.stacks.map(stackArn);

  for (const role of [diff, deploy]) {
    role.addToPolicy(new PolicyStatement({
      sid: 'DevStackRead',
      actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
      resources: stackArns,
    }));
    // 부재 검사의 AccessDenied를 "철거 완료"로 오해하지 않도록 정확한 과거 스택만 조회한다.
    role.addToPolicy(new PolicyStatement({
      sid: 'LegacyApplicationStackPresence',
      actions: ['cloudformation:DescribeStacks'],
      resources: [stackArn(INFRA_DEV_CICD.legacyStack)],
    }));
    role.addToPolicy(new PolicyStatement({
      sid: 'SeoulAvailabilityZones',
      actions: ['ec2:DescribeAvailabilityZones'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': INFRA_DEV_CICD.region } },
    }));
  }

  deploy.addToPolicy(new PolicyStatement({
    sid: 'DevStackDeploymentEvents',
    actions: ['cloudformation:DescribeStackEvents'],
    resources: stackArns,
  }));
  deploy.addToPolicy(new PolicyStatement({
    sid: 'ExistingBootstrapRoles',
    actions: ['sts:AssumeRole'],
    resources: ['deploy', 'file-publishing', 'lookup'].map(kind => stack.formatArn({
      service: 'iam',
      region: '',
      resource: 'role',
      resourceName: `cdk-${INFRA_DEV_CICD.bootstrapQualifier}-${kind}-role-${stack.account}-${INFRA_DEV_CICD.region}`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    })),
  }));
  // 기존 bootstrap의 관리자급 실행 권한을 재사용한다. 이 진입 역할은 dev/prod IAM 격리가 아니다.
  // lookup은 승인된 배포의 CDK 실패 진단에만 필요하며 diff 역할에는 AssumeRole을 주지 않는다.

  new CfnOutput(scope, 'InfraDevDiffRoleArn', {
    value: diff.roleArn,
    description: 'GitHub Actions infra dev read-only diff role (ADR-0044)',
  });
  new CfnOutput(scope, 'InfraDevDeployRoleArn', {
    value: deploy.roleArn,
    description: 'GitHub Actions infra dev approved deployment role (ADR-0044)',
  });

  return { diff, deploy };
}
