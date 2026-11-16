import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib/core';
import { IOidcProvider, OpenIdConnectPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { DELIVERY_CONTRACT as D } from '../common/delivery-contract';
import { VALUES_SYNC_CONTRACT } from '../common/values-sync-contract';
import { ECR_REPOS } from '../common/config';
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_DOMAIN, GITHUB_ORG } from './config';
import { INFRA_DEV_CICD } from './infra-dev-roles';

/** 보호된 infra GitOps 실행의 읽기·게시 준비 역할이다. CDK 배포와 Kubernetes 쓰기는 허용하지 않는다. */
export function createInfraGitOpsRole(stack: Stack, provider: IOidcProvider): Role {
  const role = new Role(stack, 'InfraGitOpsRole', {
    roleName: D.infraRoleName,
    description: 'Infra dev GitOps configuration and initialization read-only AWS access',
    maxSessionDuration: Duration.hours(1),
    assumedBy: new OpenIdConnectPrincipal(provider, { StringEquals: {
      [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
      // Environment subject에는 branch가 없으므로 Environment와 workflow가 develop·파일 경로를 고정한다.
      [`${GITHUB_OIDC_DOMAIN}:sub`]: `repo:${GITHUB_ORG.name}@${GITHUB_ORG.id}/${INFRA_DEV_CICD.repository.name}@${INFRA_DEV_CICD.repository.id}:environment:${D.infraEnvironment}`,
    } }),
  });
  role.addToPolicy(new PolicyStatement({
    actions: ['cloudformation:DescribeStacks', 'cloudformation:GetTemplate'],
    resources: INFRA_DEV_CICD.stacks.map(name => stack.formatArn({ service: 'cloudformation',
      region: INFRA_DEV_CICD.region, resource: 'stack', resourceName: `${name}/*`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
  }));
  role.addToPolicy(new PolicyStatement({
    actions: ['ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
    resources: [ECR_REPOS.enrollmentApi, ECR_REPOS.telemetryIngest, ECR_REPOS.telemetryGateway, ECR_REPOS.dashboardApi]
      .map(name => stack.formatArn({ service: 'ecr', resource: 'repository', resourceName: name, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
  }));
  role.addToPolicy(new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
  role.addToPolicy(new PolicyStatement({
    actions: ['sts:AssumeRole'],
    resources: [D.observerRoleName, VALUES_SYNC_CONTRACT.readerRoleName]
      .map(name => stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: name, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
  }));
  new CfnOutput(stack, 'InfraGitOpsRoleArn', { value: role.roleArn });
  return role;
}
