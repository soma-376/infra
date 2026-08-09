import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  PORTS,
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

  test('마스터 시크릿과 post-processor 파생 DSN 시크릿 2개를 만든다', () => {
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

  // DSN 에는 DB 비밀번호가 통째로 들어간다. 합성 산출물에 평문이 한 조각이라도
  // 남으면 CloudFormation 템플릿과 콘솔에 그대로 노출된다. (ADR-0018, ADR-0022 7번)
  test('DSN 시크릿은 Fn::Join + 동적 참조로만 이뤄지고 평문 자격증명이 없다', () => {
    const join = derivedDsnSecret().Properties.SecretString['Fn::Join'];
    expect(join).toBeDefined();

    const parts = join[1] as unknown[];
    const literals = parts
      .filter((part): part is string => typeof part === 'string')
      .join('');

    // username/password 는 반드시 동적 참조로만 등장한다.
    expect(literals).toContain('{{resolve:secretsmanager:');
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

  // 형식이 운영과 갈리면 post-processor 가 dev 에서만 다르게 동작한다. (ADR-0022 7번)
  test('DSN 리터럴에 운영과 같은 접속 계약이 들어간다', () => {
    const literals = (
      derivedDsnSecret().Properties.SecretString['Fn::Join'][1] as unknown[]
    )
      .filter((part): part is string => typeof part === 'string')
      .join('');

    expect(literals).toContain(`dbname=${CONTROL_DB_NAME}`);
    expect(literals).toContain(` port=${PORTS.aurora} `);
    expect(literals).toContain(`sslmode=${CONTROL_DB_SSLMODE}`);
  });

  // 우리는 libpq DSN 값을 따옴표로 감싸지 않는다(합성 시점엔 토큰이라 감쌀 수 없다).
  // 대신 aws-rds 가 자동 생성 비밀번호에서 제외하는 문자 집합이, 따옴표 없는
  // keyword/value DSN 을 깨뜨리는 문자 4개를 전부 포함한다는 사실에 의존한다.
  // **이건 우연히 성립하는 커플링이라** 라이브러리 업그레이드로 조용히 깨질 수 있고,
  // 깨지면 배포는 성공하고 post-processor 만 런타임에 죽는다. (ADR-0018)
  //
  // DEFAULT_PASSWORD_EXCLUDE_CHARS 는 aws-rds/lib/private/util 에만 있고 공개
  // 엔트리포인트에서 export 되지 않으므로 합성 템플릿을 권위 소스로 삼는다.
  // DatabaseInstance 도 DatabaseCluster 와 같은 상수를 쓰지만 그 사실 자체는
  // 상수 import 로 검증할 수 없다.
  test('자동 생성 비밀번호는 따옴표 없는 libpq DSN 을 깨뜨릴 문자를 제외한다', () => {
    const generated = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter((resource: any) => resource.Properties.GenerateSecretString);

    expect(generated).toHaveLength(1);
    const generate = (generated[0] as any).Properties.GenerateSecretString;
    expect(generate.GenerateStringKey).toBe('password');

    const excluded: string = generate.ExcludeCharacters;
    const unsafe: ReadonlyArray<readonly [string, string]> = [
      ['공백(키 구분자)', ' '],
      ['작은따옴표(인용)', "'"],
      ['큰따옴표(인용)', '"'],
      ['역슬래시(이스케이프)', '\\'],
    ];
    for (const [label, char] of unsafe) {
      // 어느 문자가 빠졌는지 실패 메시지에 그대로 드러나게 한다.
      expect({ [label]: excluded.includes(char) }).toEqual({ [label]: true });
    }
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
