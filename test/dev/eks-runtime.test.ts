import { App, ArnFormat, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { DevEksRuntime } from '../../lib/dev/eks-runtime';
import { TEST_ENV, buildDevApp } from '../helpers';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MSK_PREFIX = 'arn:aws:kafka:ap-northeast-2:111111111111';
const MSK = {
  clusterArn: `${MSK_PREFIX}:cluster/runtime-msk/uuid-1`,
  topicArn: `${MSK_PREFIX}:topic/runtime-msk/uuid-1/pulsemetry-dev-telemetry-ingress-validation`,
  consumerGroupArn: `${MSK_PREFIX}:group/runtime-msk/uuid-1/pulsemetry-dev-telemetry-ingest-validation`,
};

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
    dashboardRdsSourceSecret: secret('dashboardRdsSourceSecret'),
    dashboardRdsCacheSecret: secret('dashboardRdsCacheSecret'),
    dashboardClickHouseSourceSecret: secret('dashboardClickHouseSourceSecret'),
    dashboardClickHouseCacheSecret: secret('dashboardClickHouseCacheSecret'),
    managementResponseKeySecret: secret('managementResponseKeySecret'),
    mailEncryptionKeySecret: secret('mailEncryptionKeySecret'),
    userJwtPrivateKeySecret: secret('userJwtPrivateKeySecret'),
    userJwtPublicKeysSecret: secret('userJwtPublicKeysSecret'),
    rawSignalBucket: Bucket.fromBucketName(stack, 'RawBucket', 'runtime-test-raw'),
    archivePrefix: prefix,
    telemetryJwtPrivateKeySecret: secret('telemetryJwtPrivateKeySecret'),
    telemetryJwtPublicKeysSecret: secret('telemetryJwtPublicKeysSecret'),
    msk: MSK,
  });
  return Template.fromStack(stack);
}

describe('EKS runtime 소비자 경계', () => {
  test('기존 Secret 참조만 사용하며 새 Secret이나 credential output이 없다', () => {
    const template = synth();
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    const json = template.toJSON();
    expect(Object.keys(json.Outputs).sort()).toEqual([
      'ApplicationLogGroupName', 'ArchivePrefix',
      'MskGatewayRoleArn', 'MskGatewaySessionName', 'MskIngestRoleArn', 'MskIngestSessionName',
      'MskOffsetAdminRoleArn', 'MskOffsetAdminSessionName', 'MskTopicAdminRoleArn', 'MskTopicAdminSessionName',
      'RuntimeDashboardRoleArn', 'RuntimeEnrollmentRoleArn', 'RuntimeFluentBitRoleArn',
      'RuntimeTelemetryGatewayRoleArn', 'RuntimeTelemetryIngestRoleArn',
      'RuntimeTelemetryKafkaAdminRoleArn', 'RuntimeTelemetryKafkaOffsetsRoleArn',
    ]);
    expect(JSON.stringify(json)).not.toContain('{{resolve:secretsmanager:');
  });

  test.each([
    ['enrollment-api', 'pulsemetry-dev'],
    ['telemetry-ingest', 'pulsemetry-dev'],
    ['dashboard-api', 'pulsemetry-dev'],
    ['telemetry-gateway', 'pulsemetry-dev'],
    ['telemetry-kafka-admin', 'pulsemetry-dev'],
    ['telemetry-kafka-offsets', 'pulsemetry-dev'],
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

  test('admin·telemetry 개인키는 enrollment에만, HMAC·DB·telemetry 공개키는 두 앱에 연결한다', () => {
    const policies = Object.entries(synth().findResources('AWS::IAM::Policy'));
    const enrollment = policies.find(([id]) => id.includes('Enrollment'))![1];
    const ingest = policies.find(([id]) => id.includes('TelemetryIngest'))![1];
    const actions = ['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue'];
    const enrollmentRead = enrollment.Properties.PolicyDocument.Statement[0];
    expect(enrollmentRead.Action).toEqual(actions);
    expect(enrollmentRead.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'true' } });
    expect(enrollmentRead.Resource).toHaveLength(9);
    for (const name of ['db', 'hmac', 'admin', 'userJwtPrivateKeySecret', 'userJwtPublicKeysSecret',
      'telemetryJwtPrivateKeySecret', 'telemetryJwtPublicKeysSecret']) {
      expect(JSON.stringify(enrollmentRead.Resource)).toContain(`:secret:${name}-abc123`);
    }
    const read = ingest.Properties.PolicyDocument.Statement.find((s: any) => JSON.stringify(s.Action).includes('secretsmanager:'));
    expect(read.Action).toEqual(actions);
    expect(read.Resource).toHaveLength(3);
    for (const name of ['db', 'hmac', 'telemetryJwtPublicKeysSecret']) expect(JSON.stringify(read.Resource)).toContain(`:secret:${name}-abc123`);
    expect(JSON.stringify(ingest)).not.toContain(':secret:admin-');
    expect(JSON.stringify(ingest)).not.toContain('userJwt');
    expect(JSON.stringify(ingest)).not.toContain('telemetryJwtPrivateKeySecret');
  });

  test('dashboard는 네 DB 원본과 공개키만 읽고 쓰기·개인키·기존 인증 원본은 받지 않는다', () => {
    const policy = Object.entries(synth().findResources('AWS::IAM::Policy')).find(([id]) => id.includes('Dashboard'))![1];
    const statements = policy.Properties.PolicyDocument.Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0].Action).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
    expect(statements[0].Resource).toHaveLength(5);
    for (const name of ['dashboardRdsSourceSecret', 'dashboardRdsCacheSecret', 'dashboardClickHouseSourceSecret', 'dashboardClickHouseCacheSecret', 'userJwtPublicKeysSecret']) expect(JSON.stringify(policy)).toContain(`:secret:${name}-abc123`);
    for (const name of ['userJwtPrivateKeySecret', ':secret:db-', ':secret:hmac-', ':secret:admin-', 's3:', 'telemetryJwt', 'kafka-cluster:', 'sts:']) expect(JSON.stringify(policy)).not.toContain(name);
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

  describe('telemetry Gateway·Kafka 관리 Job과 MSK 전용 역할', () => {
    const template = synth();
    const resources = template.toJSON().Resources as Record<string, any>;
    const policies = Object.entries(template.findResources('AWS::IAM::Policy')) as [string, any][];
    const policyOf = (prefix: string) => {
      const matched = policies.filter(([, policy]) => policy.Properties.Roles.some((role: any) => role.Ref.startsWith(prefix)));
      expect(matched).toHaveLength(1);
      return matched[0][1].Properties.PolicyDocument.Statement as any[];
    };
    const roleId = (prefix: string) => {
      const ids = Object.keys(resources).filter(id => id.startsWith(prefix) && resources[id].Type === 'AWS::IAM::Role');
      expect(ids).toHaveLength(1);
      return ids[0];
    };
    const flatten = (statements: any[]) => statements.flatMap(statement => [].concat(statement.Action)
      .map(action => [action, JSON.stringify(statement.Resource)]));
    const mskRoles = [
      ['Gateway', 'TelemetryGateway', 'telemetry-gateway', 'pulsemetry-dev-telemetry-gateway'],
      ['Ingest', 'TelemetryIngest', 'telemetry-ingest', 'pulsemetry-dev-telemetry-ingest'],
      ['TopicAdmin', 'TelemetryKafkaAdmin', 'telemetry-kafka-admin', 'pulsemetry-dev-telemetry-kafka-admin'],
      ['OffsetAdmin', 'TelemetryKafkaOffsets', 'telemetry-kafka-offsets', 'pulsemetry-dev-telemetry-kafka-offsets'],
    ] as const;

    test.each(mskRoles)('%s MSK 역할은 대응 Pod 역할만 고정 세션 이름으로 신뢰한다', (id, pod, sa, session) => {
      const msk = resources[roleId(`Runtime${id}MskRole`)];
      const podId = roleId(`Runtime${pod}Role`);
      expect(msk.Properties.Description).toBe(`Dev MSK data access for ${sa}`);
      expect(msk.Properties.AssumeRolePolicyDocument.Statement).toEqual([
        { Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: { 'Fn::GetAtt': [podId, 'Arn'] } },
          Condition: { StringEquals: { 'sts:RoleSessionName': session } } },
        { Effect: 'Allow', Action: 'sts:TagSession', Principal: { AWS: { 'Fn::GetAtt': [podId, 'Arn'] } } },
      ]);
      expect(msk.Properties.ManagedPolicyArns).toBeUndefined();
      // Pod 역할은 자기 MSK 역할만 assume한다.
      const assume = policyOf(`Runtime${pod}Role`).filter(statement => JSON.stringify(statement.Action).includes('sts:'));
      expect(assume).toEqual([{ Effect: 'Allow', Action: ['sts:AssumeRole', 'sts:TagSession'],
        Resource: { 'Fn::GetAtt': [roleId(`Runtime${id}MskRole`), 'Arn'] } }]);
      template.hasOutput(`Msk${id}SessionName`, { Value: session });
      template.hasOutput(`Msk${id}RoleArn`, { Value: { 'Fn::GetAtt': [roleId(`Runtime${id}MskRole`), 'Arn'] } });
    });

    test.each([
      ['Gateway', [['kafka-cluster:Connect', 'cluster'], ['kafka-cluster:WriteDataIdempotently', 'cluster'],
        ['kafka-cluster:DescribeTopic', 'topic'], ['kafka-cluster:WriteData', 'topic']]],
      ['Ingest', [['kafka-cluster:Connect', 'cluster'], ['kafka-cluster:DescribeTopic', 'topic'], ['kafka-cluster:ReadData', 'topic'],
        ['kafka-cluster:DescribeGroup', 'group'], ['kafka-cluster:AlterGroup', 'group']]],
      ['TopicAdmin', [['kafka-cluster:Connect', 'cluster'], ['kafka-cluster:CreateTopic', 'topic'], ['kafka-cluster:DescribeTopic', 'topic'],
        ['kafka-cluster:DescribeTopicDynamicConfiguration', 'topic'], ['kafka-cluster:AlterTopicDynamicConfiguration', 'topic']]],
      ['OffsetAdmin', [['kafka-cluster:Connect', 'cluster'], ['kafka-cluster:DescribeGroup', 'group'], ['kafka-cluster:AlterGroup', 'group'],
        ['kafka-cluster:DescribeTopic', 'topic'], ['kafka-cluster:ReadData', 'topic']]],
    ] as const)('%s MSK 역할은 계획의 action만 정확한 cluster·topic·group ARN에 갖는다', (id, expected) => {
      const arn = { cluster: MSK.clusterArn, topic: MSK.topicArn, group: MSK.consumerGroupArn };
      const actual = flatten(policyOf(`Runtime${id}MskRole`)).sort();
      expect(actual).toEqual(expected.map(([action, kind]) => [action, JSON.stringify(arn[kind])]).sort());
    });

    test('어떤 역할에도 wildcard·kafka 관리 API·삭제·transactional·cluster 변경 권한이 없다', () => {
      const text = JSON.stringify(policies.map(([, policy]) => policy.Properties.PolicyDocument));
      expect(text).not.toMatch(/"kafka:|kafka-cluster:\*|kafka-cluster:Delete|TransactionalId|AlterCluster|kafka-cluster:\w*Cluster\w*Configuration/);
      for (const [action, resource] of flatten(policies.flatMap(([, policy]) => policy.Properties.PolicyDocument.Statement))) {
        if (action.startsWith('kafka-cluster:')) expect(resource).not.toContain('*');
      }
    });

    test('Gateway Pod 역할은 telemetry 공개키와 자기 MSK 역할만 갖고 DB·HMAC·개인키·S3·로그 권한이 없다', () => {
      const statements = policyOf('RuntimeTelemetryGatewayRole');
      const read = statements.find(statement => JSON.stringify(statement.Action).includes('secretsmanager:'));
      expect(read.Resource).toEqual(expect.stringContaining(':secret:telemetryJwtPublicKeysSecret-abc123'));
      expect(statements).toHaveLength(2);
      const text = JSON.stringify(statements);
      for (const forbidden of [':secret:db-', ':secret:hmac-', ':secret:admin-', 'PrivateKey', 'userJwt', 's3:', 'logs:', 'kafka-cluster:', 'dashboard']) {
        expect(text).not.toContain(forbidden);
      }
    });

    test('telemetry 개인키 원본은 enrollment 정책에만 있고 관리 Job Pod 역할에는 Secret이 없다', () => {
      const holders = policies.filter(([, policy]) => JSON.stringify(policy).includes(':secret:telemetryJwtPrivateKeySecret-'));
      expect(holders.map(([, policy]) => policy.Properties.Roles[0].Ref)).toEqual([expect.stringMatching(/^RuntimeEnrollmentRole/)]);
      for (const pod of ['RuntimeTelemetryKafkaAdminRole', 'RuntimeTelemetryKafkaOffsetsRole']) {
        const statements = policyOf(pod);
        expect(statements).toHaveLength(1);
        expect(JSON.stringify(statements)).not.toMatch(/secretsmanager:|s3:|kafka-cluster:/);
      }
    });
  });
});

test('SES 발송과 관리·메일 키 읽기는 enrollment Pod에만 허용한다', () => {
  const { eks } = buildDevApp();
  const template = Template.fromStack(eks);
  const policies = Object.entries(template.findResources('AWS::IAM::Policy')) as [string, any][];
  const holders = policies.filter(([, policy]) => JSON.stringify(policy).includes('ses:SendEmail'));
  expect(holders).toHaveLength(1);
  expect(holders[0][0]).toContain('Enrollment');
  const sendStatements = holders[0][1].Properties.PolicyDocument.Statement.filter((s: any) => s.Action === 'ses:SendEmail');
  expect(sendStatements).toHaveLength(1);
  const send = sendStatements[0];
  expect(send.Condition).toEqual({ StringEquals: { 'ses:FromAddress': 'no-reply@pulsemetry.co.kr' } });
  // 계정·리전 wildcard나 configuration-set, 추가 action으로 범위를 넓히지 않는다.
  expect(JSON.stringify(send.Resource)).toContain(`:ses:${TEST_ENV.region}:${TEST_ENV.account}:identity/*`);
  expect(send.Resource).not.toBe('*');
  expect(JSON.stringify(sendStatements)).not.toMatch(/SendRawEmail|ses:\*|configuration-set|StringEqualsIfExists|ResourceTag/);
  // 앱이 자신에게 수신 승인을 부여하거나 identity를 만들 수 없어야 한다.
  for (const [, policy] of policies) {
    const statements = policy.Properties.PolicyDocument.Statement;
    for (const statement of statements) {
      const actions = [statement.Action].flat();
      expect(actions).not.toEqual(expect.arrayContaining(['ses:*']));
      expect(actions.filter((a: string) => a.startsWith('ses:'))).toEqual(
        actions.includes('ses:SendEmail') ? ['ses:SendEmail'] : [],
      );
    }
  }

  for (const id of ['DevManagementResponseKeySecret', 'DevMailEncryptionKeySecret']) {
    const readers = policies.filter(([, policy]) => JSON.stringify(policy).includes(id));
    expect(readers).toHaveLength(1);
    expect(readers[0][0]).toContain('Enrollment');
  }
});
