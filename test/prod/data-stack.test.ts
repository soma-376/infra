import { Template, Match } from 'aws-cdk-lib/assertions';
import {
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  PORTS,
} from '../../lib/common/config';
import { buildApp } from '../helpers';

describe('DataStack', () => {
  const { data } = buildApp();
  const template = Template.fromStack(data);

  test('creates an Aurora PostgreSQL cluster named controlplane with serverless v2 scaling', () => {
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      Engine: 'aurora-postgresql',
      EngineVersion: '16.13',
      DatabaseName: CONTROL_DB_NAME,
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 2,
      },
    });
  });

  test('cluster has DESTROY removal policy (DeletionPolicy Delete)', () => {
    template.hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Delete',
    });
  });

  test('Aurora 마스터 시크릿과 post-processor 파생 DSN 시크릿 2개를 만든다', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
  });

  /** 값을 직접 담은(= 파생) 시크릿. 마스터는 GenerateSecretString 쪽이다. */
  function derivedDsnSecret(): any {
    const derived = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter((resource: any) => resource.Properties.SecretString);

    expect(derived).toHaveLength(1);
    return derived[0];
  }

  test('DSN 시크릿은 Fn::Join + 동적 참조로만 이뤄지고 평문 자격증명이 없다 (ADR-0018)', () => {
    const join = derivedDsnSecret().Properties.SecretString['Fn::Join'];
    expect(join).toBeDefined();

    const parts = join[1] as unknown[];
    const literals = parts
      .filter((part): part is string => typeof part === 'string')
      .join('');

    // 리터럴 조각에는 키 이름과 상수만 있어야 한다.
    expect(literals).toContain('host=');
    expect(literals).toContain(` port=${PORTS.aurora} `);
    expect(literals).toContain(`dbname=${CONTROL_DB_NAME}`);
    expect(literals).toContain(`sslmode=${CONTROL_DB_SSLMODE}`);

    // username/password 는 반드시 동적 참조로만 등장한다.
    expect(literals).toContain(':SecretString:username::}}');
    expect(literals).toContain(':SecretString:password::}}');

    // 리터럴이 아닌 조각은 전부 CFN intrinsic 이어야 한다.
    for (const part of parts) {
      if (typeof part === 'string') {
        continue;
      }
      expect(Object.keys(part as object)[0]).toMatch(/^(Ref|Fn::GetAtt)$/);
    }
  });

  // 우리는 libpq DSN 값을 따옴표로 감싸지 않는다(합성 시점엔 토큰이라 감쌀 수 없다).
  // 대신 aws-rds 가 자동 생성 비밀번호에서 제외하는 문자 집합이, 따옴표 없는
  // keyword/value DSN 을 깨뜨리는 문자 4개를 전부 포함한다는 사실에 의존한다.
  // 이건 우연한 커플링이라 라이브러리 업그레이드로 조용히 깨질 수 있고, 깨지면
  // 배포는 성공하고 post-processor 만 런타임에 죽는다. (ADR-0018)
  //
  // DEFAULT_PASSWORD_EXCLUDE_CHARS 는 aws-rds/lib/private/util 에만 있고 공개
  // 엔트리포인트에서 export 되지 않으므로 합성 템플릿을 권위 소스로 삼는다.
  test('Aurora 자동 생성 비밀번호는 따옴표 없는 libpq DSN 을 깨뜨릴 문자를 제외한다', () => {
    const generated = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter((resource: any) => resource.Properties.GenerateSecretString);

    expect(generated).toHaveLength(1);
    const generate = (generated[0] as any).Properties.GenerateSecretString;
    expect(generate.GenerateStringKey).toBe('password');

    const excluded: string = generate.ExcludeCharacters;
    const unsafe: ReadonlyArray<readonly [string, string]> = [
      ['공백(키 구분자)', ' '],
      ["작은따옴표(인용)", "'"],
      ['큰따옴표(인용)', '"'],
      ['역슬래시(이스케이프)', '\\'],
    ];
    for (const [label, char] of unsafe) {
      // 어느 문자가 빠졌는지 실패 메시지에 그대로 드러나게 한다.
      expect({ [label]: excluded.includes(char) }).toEqual({ [label]: true });
    }
  });

  test('raw signal bucket blocks all public access', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('raw signal bucket has a 30 day expiration lifecycle rule', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' }),
        ]),
      },
    });
  });
});
