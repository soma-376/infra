import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CONTROL_DB_NAME,
  ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
} from '../../lib/common/config';
import {
  DEV_RAW_SIGNAL_EXPIRATION_DAYS,
  DEV_RDS_ALLOCATED_STORAGE_GIB,
} from '../../lib/dev/config';
import { buildDevApp } from '../helpers';

describe('DevDataStack', () => {
  const { data } = buildDevApp();
  const template = Template.fromStack(data);

  // 운영은 Aurora Serverless v2 지만 dev 는 단일 인스턴스다 (ADR-0022 6번).
  // **앱이 보는 계약(PostgreSQL 16, controlplane, 5432)은 운영과 같아야 한다** -
  // 갈라지면 "dev 에서 검증했다"가 운영에 대해 아무것도 보장하지 못한다.
  test('PostgreSQL 16 단일 인스턴스를 운영과 같은 DB 이름으로 만든다', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^16\\.'),
      DBName: CONTROL_DB_NAME,
      DBInstanceClass: 'db.t4g.micro',
    });
  });

  // publiclyAccessible + 퍼블릭 서브넷이 이 선택의 목적이다 - 로컬 psql 로 직접 붙어
  // 스키마를 부트스트랩하는 경로가 dev 의 존재 이유다. 접근 통제는 DevRdsSg 뿐이다.
  test('로컬에서 직접 붙을 수 있게 publiclyAccessible 이다 (ADR-0022 6번)', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      PubliclyAccessible: true,
    });
  });

  // dev 는 언제든 통째로 지웠다 다시 만드는 환경이다. 백업/삭제 보호가 켜지면
  // 재생성이 느려지고 비용만 붙는다.
  test('백업·다중 AZ·삭제 보호 없이 즉시 재생성 가능한 구성이다', () => {
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      AllocatedStorage: String(DEV_RDS_ALLOCATED_STORAGE_GIB),
      StorageType: 'gp3',
      MultiAZ: false,
      BackupRetentionPeriod: 0,
      DeletionProtection: false,
    });
  });

  test('DB 인스턴스는 스택 삭제 시 함께 사라진다', () => {
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  // 기존 마스터·공유 토큰 해시·관리자 토큰 + dashboard DB 자격 증명 4개 + JWT 2개.
  // 폐기한 post-processor/auth-proxy 파생 접속 시크릿은 다시 만들지 않는다. (ADR-0026)
  test('기존 3개와 dashboard DB·JWT 원본 6개로 시크릿 9개를 만든다', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 9);
  });

  /**
   * 논리 ID 접두사로 시크릿 하나를 집는다.
   *
   * 논리 ID 는 construct ID 에서 유도되므로 이 방식이 어느 시크릿을 보는지
   * 이름으로 드러난다.
   */
  function secretByIdPrefix(prefix: string): any {
    const matched = Object.entries(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter(([logicalId]) => logicalId.startsWith(prefix));

    expect(matched).toHaveLength(1);
    return matched[0][1];
  }

  function secretByName(name: string): [string, any] {
    const matched = Object.entries(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter(([, resource]: [string, any]) => resource.Properties.Name === name);

    expect(matched).toHaveLength(1);
    return matched[0];
  }

  // 고정 원본을 교체하면 기존 사용자 비밀번호·발급 토큰과 연결이 끊어진다.
  test.each([
    ['DevAuthProxyTokenHashSecret', 'DevAuthProxyTokenHashSecret9DDA266E'],
    ['DevEnrollmentAdminApiToken', 'DevEnrollmentAdminApiToken91056A11'],
  ])('기존 %s의 logical ID와 삭제 정책을 유지한다', (prefix, logicalId) => {
    const secrets = template.findResources('AWS::SecretsManager::Secret');
    expect(Object.keys(secrets).filter((id) => id.startsWith(prefix))).toEqual([
      logicalId,
    ]);
    expect(secrets[logicalId]).toMatchObject({
      DeletionPolicy: 'Delete',
      UpdateReplacePolicy: 'Delete',
    });
  });

  test.each([
    {
      name: 'soma-376/dev/dashboard/rds-source',
      username: 'dashboard_rds_source',
      secret: data.dashboardRdsSourceSecret,
      arn: data.dashboardRdsSourceSecretArn,
    },
    {
      name: 'soma-376/dev/dashboard/rds-cache',
      username: 'dashboard_rds_cache',
      secret: data.dashboardRdsCacheSecret,
      arn: data.dashboardRdsCacheSecretArn,
    },
    {
      name: 'soma-376/dev/dashboard/clickhouse-source',
      username: 'dashboard_ch_source',
      secret: data.dashboardClickHouseSourceSecret,
      arn: data.dashboardClickHouseSourceSecretArn,
    },
    {
      name: 'soma-376/dev/dashboard/clickhouse-cache',
      username: 'dashboard_ch_cache',
      secret: data.dashboardClickHouseCacheSecret,
      arn: data.dashboardClickHouseCacheSecretArn,
    },
  ])('$name은 사용자명과 생성 비밀번호만 보존하고 참조를 제공한다', ({
    name, username, secret, arn,
  }) => {
    const [logicalId, resource] = secretByName(name);

    expect(resource.Properties.GenerateSecretString).toEqual({
      SecretStringTemplate: JSON.stringify({ username }),
      GenerateStringKey: 'password',
      PasswordLength: 32,
      ExcludePunctuation: true,
      ExcludeUppercase: false,
      IncludeSpace: false,
    });
    expect(resource.Properties.SecretString).toBeUndefined();
    expect(resource.Properties.KmsKeyId).toBeUndefined();
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.UpdateReplacePolicy).toBe('Retain');
    expect(data.resolve(secret.secretArn)).toEqual({ Ref: logicalId });
    expect(data.resolve(arn)).toEqual({ Ref: logicalId });
  });

  test.each([
    {
      name: 'soma-376/dev/user-jwt/private-key',
      secret: data.userJwtPrivateKeySecret,
      arn: data.userJwtPrivateKeySecretArn,
    },
    {
      name: 'soma-376/dev/user-jwt/public-keys',
      secret: data.userJwtPublicKeysSecret,
      arn: data.userJwtPublicKeysSecretArn,
    },
  ])('$name은 값·자동 생성 없이 보존하고 전체 ARN 참조를 제공한다', ({
    name, secret, arn,
  }) => {
    const [logicalId, resource] = secretByName(name);

    expect(resource.Properties.SecretString).toBeUndefined();
    expect(resource.Properties.GenerateSecretString).toBeUndefined();
    expect(resource.Properties.KmsKeyId).toBeUndefined();
    expect(resource.DeletionPolicy).toBe('Retain');
    expect(resource.UpdateReplacePolicy).toBe('Retain');
    expect(data.resolve(secret.secretArn)).toEqual({ Ref: logicalId });
    expect(data.resolve(secret.secretFullArn)).toEqual({ Ref: logicalId });
    expect(data.resolve(arn)).toEqual({ Ref: logicalId });
  });

  test('새 원본에 자동 회전·DB attachment·조회 정책을 만들지 않는다', () => {
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
    // 기존 RDS 마스터 Secret의 attachment 하나만 존재한다.
    template.resourceCountIs('AWS::SecretsManager::SecretTargetAttachment', 1);
    template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 0);
    // 버킷 자동 정리용 기존 역할·정책에는 Secret 조회를 추가하지 않는다.
    const iam = {
      ...template.findResources('AWS::IAM::Role'),
      ...template.findResources('AWS::IAM::Policy'),
    };
    expect(JSON.stringify(iam)).not.toContain('secretsmanager:');
    const outputs = JSON.stringify(template.findOutputs('*'));
    expect(outputs).not.toMatch(/SecretString|resolve:secretsmanager|BEGIN (PRIVATE|PUBLIC) KEY/);
  });

  test('폐기한 파생 접속 시크릿을 만들지 않는다', () => {
    const logicalIds = Object.keys(
      template.findResources('AWS::SecretsManager::Secret'),
    );

    for (const prefix of [
      'DevPostProcessorPgDsn',
      'DevAuthProxyDatabaseUrl',
    ]) {
      expect(logicalIds.some((logicalId) => logicalId.startsWith(prefix))).toBe(
        false,
      );
    }
  });

  // 이 키가 바뀌면 이미 발급된 모든 토큰의 해시가 매칭 불가가 되므로 회전을 켜지
  // 않는다. 값은 CDK 가 만들고 템플릿 어디에도 남지 않는다. (ADR-0023 4번)
  test('토큰 해시 키는 CDK 가 생성하고 값이 템플릿에 남지 않는다', () => {
    const secret = secretByIdPrefix('DevAuthProxyTokenHashSecret');

    // 기존 Secret 을 교체하지 않도록 legacy description 을 그대로 고정한다.
    expect(secret.Properties.Description).toBe(
      'HMAC-SHA256 key for dev auth-proxy telemetry token hashing (TOKEN_HASH_SECRET). Shared with the enrollment server.',
    );
    expect(secret.Properties.SecretString).toBeUndefined();
    expect(secret.Properties.GenerateSecretString).toEqual({
      PasswordLength: 64,
      ExcludePunctuation: true,
      ExcludeUppercase: false,
      IncludeSpace: false,
    });
    // 마스터 시크릿과 달리 JSON 이 아니라 문자열 전체를 생성하므로 키가 없다.
    expect(
      secret.Properties.GenerateSecretString.GenerateStringKey,
    ).toBeUndefined();
  });

  // 관리자 토큰은 64자 임의 값이며, ECS 가 JSON 필드 하나만 선택해 주입할 수 있게
  // `token` 키 아래 저장한다. 값 자체는 합성 템플릿에 없어야 한다.
  test('관리자 토큰은 JSON token 필드에 64자로 생성하고 값을 남기지 않는다', () => {
    const secret = secretByIdPrefix('DevEnrollmentAdminApiToken');

    expect(secret.Properties.SecretString).toBeUndefined();
    expect(secret.Properties.GenerateSecretString).toEqual({
      SecretStringTemplate: '{}',
      GenerateStringKey: ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
      PasswordLength: 64,
      ExcludePunctuation: true,
      ExcludeUppercase: false,
      IncludeSpace: false,
    });
    expect(secret.DeletionPolicy).toBe('Delete');
    expect(secret.UpdateReplacePolicy).toBe('Delete');
  });

  // 파생 접속 시크릿을 삭제해도 실제 RDS 마스터 Secret 의 논리 ID와 생성 속성은
  // 바뀌면 안 된다. 변경되면 기존 username/password 가 교체된다. (ADR-0026)
  test('RDS 마스터 Secret의 논리 ID와 생성 속성을 보존한다', () => {
    // dashboard 자격 증명도 password를 생성하므로 master의 construct 경로로 좁힌다.
    const generated = Object.entries(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter(([logicalId]) => logicalId.startsWith('DevDataStackDevPostgresSecret'));

    expect(generated).toHaveLength(1);
    expect(generated[0][0]).toBe(
      'DevDataStackDevPostgresSecret0E0FB6843fdaad7efa858a3daf9490cf0a702aeb',
    );
    const secret = generated[0][1] as any;
    expect(secret.DeletionPolicy).toBe('Delete');
    expect(secret.UpdateReplacePolicy).toBe('Delete');
    expect(secret.Properties.GenerateSecretString).toEqual({
      ExcludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
      GenerateStringKey: 'password',
      PasswordLength: 30,
      SecretStringTemplate: '{"username":"postgres"}',
    });
  });

  test('raw signal 버킷은 퍼블릭 접근을 전부 막는다', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  // dev 데이터는 재현용이라 운영(30일)보다 짧게 만료시킨다. 이 값이 사라지면
  // 폐기되지 않는 raw 데이터가 무한히 쌓인다.
  test('raw signal 버킷은 7일 만료 lifecycle 규칙을 갖는다', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: DEV_RAW_SIGNAL_EXPIRATION_DAYS,
            Status: 'Enabled',
          }),
        ]),
      },
    });
    expect(DEV_RAW_SIGNAL_EXPIRATION_DAYS).toBe(7);
  });
});
