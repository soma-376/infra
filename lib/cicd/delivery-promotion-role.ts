import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib/core';
import { IOidcProvider, OpenIdConnectPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { DELIVERY_CONTRACT } from '../common/delivery-contract';
import { ECR_REPOS } from '../common/config';
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_DOMAIN, GITHUB_ORG, GITHUB_REPOS } from './config';

/** 보호된 Environment의 게시 workflow만 맡는다. 이미지 push와 클러스터 쓰기는 없다. */
export function createDeliveryPromotionRole(stack: Stack, provider: IOidcProvider): Role {
  const repo = GITHUB_REPOS.dashboard;
  const role = new Role(stack, 'BackendGitOpsPromotionRole', {
    roleName: DELIVERY_CONTRACT.promotionRoleName,
    description: 'Backend dev GitOps promotion and read-only deployment observation',
    maxSessionDuration: Duration.hours(1),
    assumedBy: new OpenIdConnectPrincipal(provider, { StringEquals: {
      [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
      [`${GITHUB_OIDC_DOMAIN}:sub`]: `repo:${GITHUB_ORG.name}@${GITHUB_ORG.id}/${repo.name}@${repo.id}:environment:${DELIVERY_CONTRACT.environment}`,
    } }),
  });
  role.addToPolicy(new PolicyStatement({
    actions: ['ecr:DescribeImages', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
    resources: [ECR_REPOS.enrollmentApi, ECR_REPOS.telemetryIngest, ECR_REPOS.telemetryGateway, ECR_REPOS.dashboardApi]
      .map(name => stack.formatArn({ service: 'ecr', resource: 'repository', resourceName: name, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
  }));
  // 후보 컨테이너를 실행하지 않고 실제 이미지 파일을 추출할 때의 Docker pull 인증이다.
  role.addToPolicy(new PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
  role.addToPolicy(new PolicyStatement({
    actions: ['sts:AssumeRole'],
    resources: [DELIVERY_CONTRACT.observerRoleName]
      .map(name => stack.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: name, arnFormat: ArnFormat.SLASH_RESOURCE_NAME })),
  }));
  new CfnOutput(stack, 'GitOpsPromotionRoleArn', { value: role.roleArn });
  return role;
}
