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

  // 마스터(RDS 자동 생성) + post-processor 파생 DSN + auth-proxy 파생 URI +
  // auth-proxy 토큰 해시 키. (ADR-0018, ADR-0023)
  test('시크릿 4개를 만든다', () => {
    template.resourceCountIs('AWS::SecretsManager::Secret', 4);
  });

  /**
   * 논리 ID 접두사로 시크릿 하나를 집는다.
   *
   * 예전에는 `SecretString` 유무로 갈랐지만 auth-proxy 가 들어오면서 파생 시크릿이
   * 둘이 되어 더 이상 유일하지 않다. 논리 ID 는 construct ID 에서 유도되므로
   * 이 방식이 어느 시크릿을 보는지 이름으로 드러난다.
   */
  function secretByIdPrefix(prefix: string): any {
    const matched = Object.entries(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter(([logicalId]) => logicalId.startsWith(prefix));

    expect(matched).toHaveLength(1);
    return matched[0][1];
  }

  /** post-processor 용 libpq keyword/value DSN 시크릿. */
  function derivedDsnSecret(): any {
    return secretByIdPrefix('DevPostProcessorPgDsn');
  }

  /** auth-proxy 용 URI 형식 DSN 시크릿. (ADR-0023) */
  function authProxyDatabaseUrlSecret(): any {
    return secretByIdPrefix('DevAuthProxyDatabaseUrl');
  }

  /** Fn::Join 의 리터럴 조각만 이어붙인다. */
  function joinedLiterals(secret: any): string {
    return (secret.Properties.SecretString['Fn::Join'][1] as unknown[])
      .filter((part): part is string => typeof part === 'string')
      .join('');
  }

  // DSN 에는 DB 비밀번호가 통째로 들어간다. 합성 산출물에 평문이 한 조각이라도
  // 남으면 CloudFormation 템플릿과 콘솔에 그대로 노출된다. (ADR-0018, ADR-0022 7번)
  // **파생 시크릿 둘 다 검사한다.** auth-proxy 쪽에서 이 성질이 깨져도 증상은 같다 -
  // 템플릿과 콘솔에 DB 비밀번호가 그대로 남는다. (ADR-0018, ADR-0023)
  test.each([
    ['post-processor libpq DSN', () => derivedDsnSecret()],
    ['auth-proxy Postgres URI', () => authProxyDatabaseUrlSecret()],
  ])(
    '%s 시크릿은 Fn::Join + 동적 참조로만 이뤄지고 평문 자격증명이 없다',
    (_label, pick) => {
      const join = pick().Properties.SecretString['Fn::Join'];
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
    },
  );

  // 형식이 운영과 갈리면 post-processor 가 dev 에서만 다르게 동작한다. (ADR-0022 7번)
  test('DSN 리터럴에 운영과 같은 접속 계약이 들어간다', () => {
    const literals = joinedLiterals(derivedDsnSecret());

    expect(literals).toContain(`dbname=${CONTROL_DB_NAME}`);
    expect(literals).toContain(` port=${PORTS.aurora} `);
    expect(literals).toContain(`sslmode=${CONTROL_DB_SSLMODE}`);
  });

  // **auth-proxy 는 libpq DSN 을 읽지 못한다.** `pg` 의 파서는 URI 전용이라
  // keyword/value 를 주면 공백이 %20 으로 인코딩되어 통째로 망가진다. 두 시크릿의
  // 형식이 서로 달라야 한다는 것이 계약이다. (ADR-0023)
  test('auth-proxy DSN 은 libpq 가 아니라 URI 형식이다', () => {
    const literals = joinedLiterals(authProxyDatabaseUrlSecret());

    expect(literals).toContain('postgresql://');
    expect(literals).toContain(`:${PORTS.aurora}/${CONTROL_DB_NAME}?`);
    // libpq keyword/value 흔적이 섞이면 안 된다.
    expect(literals).not.toContain('host=');
    expect(literals).not.toContain('dbname=');
  });

  // **`uselibpqcompat=true` 가 빠지면 배포는 성공하고 auth-proxy 만 런타임에 죽는다.**
  // pg-connection-string 은 이 플래그가 없을 때 sslmode=require 를 verify-full 의
  // 별칭으로 취급해 rejectUnauthorized 를 켜고, RDS 기본 CA 는 Node 기본 CA 번들에
  // 없으므로 접속 자체가 실패한다. 라이브러리가 직접 이 플래그를 권고한다. (ADR-0023)
  test('auth-proxy URI 는 libpq 호환 플래그와 함께 sslmode 를 준다', () => {
    const literals = joinedLiterals(authProxyDatabaseUrlSecret());

    expect(literals).toContain('uselibpqcompat=true');
    expect(literals).toContain(`sslmode=${CONTROL_DB_SSLMODE}`);
  });

  // 이 키가 바뀌면 이미 발급된 모든 토큰의 해시가 매칭 불가가 되므로 회전을 켜지
  // 않는다. 값은 CDK 가 만들고 템플릿 어디에도 남지 않는다. (ADR-0023 4번)
  test('토큰 해시 키는 CDK 가 생성하고 값이 템플릿에 남지 않는다', () => {
    const secret = secretByIdPrefix('DevAuthProxyTokenHashSecret');

    expect(secret.Properties.SecretString).toBeUndefined();
    expect(secret.Properties.GenerateSecretString).toMatchObject({
      PasswordLength: 64,
      ExcludePunctuation: true,
    });
    // 마스터 시크릿과 달리 JSON 이 아니라 문자열 전체를 생성하므로 키가 없다.
    expect(
      secret.Properties.GenerateSecretString.GenerateStringKey,
    ).toBeUndefined();
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
  //
  // **auth-proxy 가 들어오면서 이 커플링이 두 배가 됐다.** URI 형식은 libpq 와 다른
  // 문자에 취약하고(`@` `/` `?` `#` `%` `:` `[` `]`), 합성 시점에 password 는 토큰이라
  // 퍼센트 인코딩도 불가능하다. 두 집합을 한 테스트에서 함께 고정한다. (ADR-0023)
  test('자동 생성 비밀번호는 libpq DSN 과 URI 를 깨뜨릴 문자를 모두 제외한다', () => {
    // GenerateSecretString 을 쓰는 시크릿이 둘이 됐다(마스터 + 토큰 해시 키).
    // 여기서 보려는 것은 **RDS 마스터 비밀번호**이므로 GenerateStringKey 로 좁힌다.
    const generated = Object.values(
      template.findResources('AWS::SecretsManager::Secret'),
    ).filter(
      (resource: any) =>
        resource.Properties.GenerateSecretString?.GenerateStringKey ===
        'password',
    );

    expect(generated).toHaveLength(1);
    const generate = (generated[0] as any).Properties.GenerateSecretString;

    const excluded: string = generate.ExcludeCharacters;
    const unsafe: ReadonlyArray<readonly [string, string]> = [
      // libpq keyword/value (ADR-0018)
      ['공백(키 구분자)', ' '],
      ['작은따옴표(인용)', "'"],
      ['큰따옴표(인용)', '"'],
      ['역슬래시(이스케이프)', '\\'],
      // URI (ADR-0023)
      ['@(userinfo 구분자)', '@'],
      ['/(경로 구분자)', '/'],
      ['?(쿼리 구분자)', '?'],
      ['#(프래그먼트 구분자)', '#'],
      ['%(퍼센트 인코딩)', '%'],
      [':(userinfo/포트 구분자)', ':'],
      ['[(IPv6 리터럴)', '['],
      ['](IPv6 리터럴)', ']'],
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
