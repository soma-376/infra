import { Template } from 'aws-cdk-lib/assertions';
import { LANDING_DEPLOY } from '../../lib/cicd/landing-deploy-role';
import { buildCicdApp } from '../helpers';

interface PermissionStatement {
  readonly Sid?: string;
  readonly Action: string | string[];
  readonly Resource: unknown;
  readonly Effect: string;
  readonly Condition?: unknown;
}

const asArray = <T>(value: T | T[]): T[] => Array.isArray(value) ? value : [value];

describe('랜딩 정적 사이트 배포 역할 (ADR-0060)', () => {
  const { deploy } = buildCicdApp();
  const template = Template.fromStack(deploy);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [roleId, roleResource] = (Object.entries(template.findResources('AWS::IAM::Role'))
    .find(([, resource]) => resource.Properties.RoleName === LANDING_DEPLOY.roleName) ?? ['', undefined]) as [string, any];
  const statements = (): PermissionStatement[] => Object.values(template.findResources('AWS::IAM::Policy'))
    .filter(resource => resource.Properties.Roles.some((reference: { Ref: string }) => reference.Ref === roleId))
    .flatMap(resource => resource.Properties.PolicyDocument.Statement);
  const bySid = (sid: string): PermissionStatement => {
    const found = statements().find(statement => statement.Sid === sid);
    expect(found).toBeDefined();
    return found as PermissionStatement;
  };

  test('고정 이름의 역할이 1개 존재한다', () => {
    expect(roleId).toBeDefined();
    expect(roleResource.Properties.MaxSessionDuration).toBe(3600);
    expect(roleResource.Properties.Description).toMatch(/^[\x20-\x7e]+$/);
    expect(roleResource.Properties.ManagedPolicyArns).toBeUndefined();
    expect(roleResource.Properties.Policies).toBeUndefined();
  });

  test('랜딩 저장소 main 브랜치의 immutable subject만 StringEquals로 신뢰한다', () => {
    const trust = roleResource.Properties.AssumeRolePolicyDocument.Statement;
    expect(trust).toHaveLength(1);
    expect(trust[0].Action).toBe('sts:AssumeRoleWithWebIdentity');
    expect(Object.keys(trust[0].Condition)).toEqual(['StringEquals']);
    expect(trust[0].Condition.StringEquals).toEqual({
      'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
      'token.actions.githubusercontent.com:sub':
        'repo:soma-376@297555253/pulsemetry-landing@1444074394:ref:refs/heads/main',
    });
    const [providerId] = Object.keys(template.findResources('AWS::IAM::OIDCProvider'));
    expect(trust[0].Principal.Federated).toEqual({ Ref: providerId });
  });

  test('sync·invalidation 네 액션만 허용하고 와일드카드 리소스가 없다', () => {
    expect([...new Set(statements().flatMap(statement => asArray(statement.Action)))].sort()).toEqual([
      'cloudfront:CreateInvalidation', 's3:DeleteObject', 's3:ListBucket', 's3:PutObject',
    ]);
    for (const statement of statements()) {
      expect(statement.Effect).toBe('Allow');
      expect(asArray(statement.Resource)).not.toContain('*');
    }
  });

  test('S3 권한은 랜딩 버킷과 그 객체로만 좁힌다', () => {
    expect(bySid('LandingBucketList').Resource).toEqual('arn:aws:s3:::pulsemetry-landing-prod');
    expect(bySid('LandingObjectsWrite').Resource).toEqual('arn:aws:s3:::pulsemetry-landing-prod/*');
  });

  test('invalidation은 랜딩 CloudFront 배포 하나로 좁힌다', () => {
    expect(bySid('LandingCdnInvalidation').Resource).toEqual('arn:aws:cloudfront::111111111111:distribution/EQE94IEKI2ZPY');
  });

  test('워크플로 설정용 ARN output을 낸다', () => {
    const output = template.findOutputs('PulsemetryLandingProdDeployRoleArn').PulsemetryLandingProdDeployRoleArn;
    expect(output.Value).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
    expect(deploy.resolve(deploy.landingDeployRole.roleArn)).toEqual({ 'Fn::GetAtt': [roleId, 'Arn'] });
  });

  test('기존 앱 역할 맵에 섞이지 않는다', () => {
    expect(Object.keys(deploy.deployRoles)).not.toContain(LANDING_DEPLOY.roleName);
    expect(Object.keys(deploy.deployRoles)).toHaveLength(4);
  });
});
