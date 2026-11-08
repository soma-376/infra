import { ArnFormat, CfnOutput, Duration, Stack } from 'aws-cdk-lib/core';
import { IOidcProvider, OpenIdConnectPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import {
  buildGithubOidcSubject,
  GitHubRepository,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_DOMAIN,
  GITHUB_ORG,
} from './config';

/**
 * 랜딩 정적 사이트의 GitHub Actions 배포 계약 (ADR-0060).
 *
 * 버킷과 CloudFront 배포는 이 레포가 만들지 않은 **외부 리소스**다. 이름·ID가 바뀌면
 * CloudFormation은 정책을 그대로 배포하고 GitHub Actions만 AccessDenied로 죽으므로
 * 여기 값과 랜딩 저장소 Variables의 `CLOUDFRONT_DISTRIBUTION_ID`를 함께 바꾼다.
 */
export const LANDING_DEPLOY = {
  repository: { name: 'pulsemetry-landing', id: '1444074394' } satisfies GitHubRepository,
  // 랜딩 저장소는 develop 없이 main 단일 브랜치로 배포한다.
  branch: 'main',
  bucketName: 'pulsemetry-landing-prod',
  distributionId: 'EQE94IEKI2ZPY',
  roleName: 'github-deploy-pulsemetry-landing-prod',
} as const;

/**
 * `aws s3 sync --delete` 와 `aws cloudfront create-invalidation` 이 실제로 호출하는 것만 준다.
 *
 * sync는 크기·수정 시각을 ListObjectsV2로만 비교하므로 `s3:GetObject` 는 필요 없다.
 * 버킷 정책·ACL·CloudFront 설정 변경 권한은 의도적으로 없다 - CI가 배포 대상의 공개 범위를
 * 바꿀 수 없어야 한다.
 */
export function createLandingDeployRole(scope: Construct, oidcProvider: IOidcProvider): Role {
  const stack = Stack.of(scope);

  const role = new Role(scope, 'PulsemetryLandingProdDeployRole', {
    roleName: LANDING_DEPLOY.roleName,
    // IAM Description은 Latin-1 밖의 문자를 거부하므로 영문으로 쓴다.
    description: `Deploy role for ${GITHUB_ORG.name}/${LANDING_DEPLOY.repository.name} on branch ${LANDING_DEPLOY.branch} to S3 and CloudFront (ADR-0060)`,
    maxSessionDuration: Duration.hours(1),
    assumedBy: new OpenIdConnectPrincipal(oidcProvider, {
      // 앱 역할과 같은 이유로 StringEquals + immutable subject다 (ADR-0024 2번).
      StringEquals: {
        [`${GITHUB_OIDC_DOMAIN}:aud`]: GITHUB_OIDC_AUDIENCE,
        [`${GITHUB_OIDC_DOMAIN}:sub`]: buildGithubOidcSubject(LANDING_DEPLOY.repository, LANDING_DEPLOY.branch),
      },
    }),
  });

  const bucketArn = `arn:${stack.partition}:s3:::${LANDING_DEPLOY.bucketName}`;

  role.addToPolicy(new PolicyStatement({
    sid: 'LandingBucketList',
    actions: ['s3:ListBucket'],
    resources: [bucketArn],
  }));
  role.addToPolicy(new PolicyStatement({
    sid: 'LandingObjectsWrite',
    actions: ['s3:PutObject', 's3:DeleteObject'],
    resources: [`${bucketArn}/*`],
  }));
  role.addToPolicy(new PolicyStatement({
    sid: 'LandingCdnInvalidation',
    actions: ['cloudfront:CreateInvalidation'],
    resources: [stack.formatArn({
      service: 'cloudfront',
      // CloudFront는 글로벌 서비스라 ARN에 리전이 없다.
      region: '',
      resource: 'distribution',
      resourceName: LANDING_DEPLOY.distributionId,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    })],
  }));

  // 랜딩 저장소 Variables `AWS_DEPLOY_ROLE_ARN` 에 들어가는 값.
  new CfnOutput(scope, 'PulsemetryLandingProdDeployRoleArn', {
    value: role.roleArn,
    description: `${GITHUB_ORG.name}/${LANDING_DEPLOY.repository.name} @ ${LANDING_DEPLOY.branch} -> s3://${LANDING_DEPLOY.bucketName} + CloudFront ${LANDING_DEPLOY.distributionId}`,
  });

  return role;
}
