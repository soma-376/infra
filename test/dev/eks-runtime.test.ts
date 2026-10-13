import { App, ArnFormat, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { DevEksRuntime } from '../../lib/dev/eks-runtime';
import { TEST_ENV } from '../helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function synth(prefix: 'eks_validation' | 'eks' = 'eks_validation') {
  const context = JSON.parse(readFileSync(join(__dirname, '../../cdk.json'), 'utf8')).context;
  const stack = new Stack(new App({ context }), 'RuntimeTest', { env: TEST_ENV });
  const secret = (name: string) => Secret.fromSecretCompleteArn(stack, name, stack.formatArn({
    service: 'secretsmanager', resource: 'secret', resourceName: `${name}-abc123`,
    arnFormat: ArnFormat.COLON_RESOURCE_NAME,
  }));
  new DevEksRuntime(stack, 'Runtime', {
    clusterName: 'runtime-test', dbSecret: secret('db'),
    tokenHashSecret: secret('hmac'), adminApiTokenSecret: secret('admin'),
    rawSignalBucket: Bucket.fromBucketName(stack, 'RawBucket', 'runtime-test-raw'),
    archivePrefix: prefix,
  });
  return Template.fromStack(stack);
}

describe('EKS runtime 소비자 경계', () => {
  test('기존 Secret 참조만 사용하며 새 Secret이나 credential output이 없다', () => {
    const template = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const json = template.toJSON();
    expect(Object.keys(json.Outputs).sort()).toEqual([
      'ApplicationLogGroupName', 'ArchivePrefix', 'RuntimeEnrollmentRoleArn',
      'RuntimeFluentBitRoleArn', 'RuntimeTelemetryIngestRoleArn',
    ]);
    expect(JSON.stringify(json)).not.toContain('{{resolve:secretsmanager:');
  });

  test.each([
    ['enrollment-api', 'pulsemetry-dev'],
    ['telemetry-ingest', 'pulsemetry-dev'],
    ['fluent-bit', 'pulsemetry-dev-logs'],
  ])('%s만 지정 namespace·cluster로 역할을 사용할 수 있다', (sa, namespace) => {
    const template = synth();
    template.hasResourceProperties('AWS::EKS::PodIdentityAssociation', {
      ClusterName: 'runtime-test', Namespace: namespace, ServiceAccount: sa, DisableSessionTags: false,
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow', Principal: { Service: 'pods.eks.amazonaws.com' },
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Condition: { StringEquals: {
            'aws:RequestTag/eks-cluster-name': 'runtime-test',
            'aws:RequestTag/kubernetes-namespace': namespace,
            'aws:RequestTag/kubernetes-service-account': sa,
          } },
        }],
      },
    });
  });

  test('admin 참조는 enrollment에만, HMAC과 DB는 두 앱에 연결한다', () => {
    const policies = Object.entries(synth().findResources('AWS::IAM::Policy'));
    const enrollment = policies.find(([id]) => id.includes('Enrollment'))![1];
    const ingest = policies.find(([id]) => id.includes('TelemetryIngest'))![1];
    const actions = ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'];
    const enrollmentRead = enrollment.Properties.PolicyDocument.Statement[0];
    expect(enrollmentRead.Action).toEqual(actions);
    expect(enrollmentRead.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'true' } });
    expect(enrollmentRead.Resource).toHaveLength(3);
    for (const name of ['db', 'hmac', 'admin']) {
      expect(JSON.stringify(enrollmentRead.Resource)).toContain(`:secret:${name}-abc123`);
    }
    const read = ingest.Properties.PolicyDocument.Statement.find((s: any) => Array.isArray(s.Action));
    expect(read.Action).toEqual(actions);
    expect(read.Resource).toHaveLength(2);
    for (const name of ['db', 'hmac']) expect(JSON.stringify(read.Resource)).toContain(`:secret:${name}-abc123`);
    expect(JSON.stringify(ingest)).not.toContain(':secret:admin-');
  });

  test.each(['eks_validation', 'eks'] as const)('%s prefix와 PutObject 범위가 일치한다', prefix => {
    const template = synth(prefix);
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: { Statement: Match.arrayWith([{
        Effect: 'Allow', Action: 's3:PutObject',
        Resource: `arn:aws:s3:::runtime-test-raw/${prefix}/*`,
        Condition: { Bool: { 'aws:SecureTransport': 'true' } },
      }]) },
    });
    template.hasOutput('ArchivePrefix', { Value: prefix });
    const policies = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    expect(policies).not.toMatch(/s3:(Get|List|Delete|Abort|PutObjectTagging)/);
    expect(policies).not.toContain('runtime-test-raw/*');
  });

  test('다른 prefix는 조립 시 거절한다', () => {
    expect(() => synth('' as 'eks')).toThrow('archivePrefix');
    expect(() => synth('../' as 'eks')).toThrow('archivePrefix');
  });

  test('Fluent Bit은 CDK 로그 그룹에만 전달하며 그룹 생성 권한이 없다', () => {
    const template = synth();
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/eks/dev/application', RetentionInDays: 14,
    });
    const fluent = Object.entries(template.findResources('AWS::IAM::Policy'))
      .find(([id]) => id.includes('FluentBit'))![1];
    expect(fluent.Properties.PolicyDocument.Statement).toEqual([{
      Effect: 'Allow', Action: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
      Resource: expect.objectContaining({ 'Fn::GetAtt': expect.arrayContaining(['Arn']) }),
    }]);
    expect(JSON.stringify(fluent)).not.toContain('CreateLogGroup');
    expect(JSON.stringify(fluent)).not.toContain('secretsmanager:');
  });
});
