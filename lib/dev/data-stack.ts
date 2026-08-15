import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  Credentials,
  DatabaseInstance,
  DatabaseInstanceEngine,
  PostgresEngineVersion,
  StorageType,
} from 'aws-cdk-lib/aws-rds';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { BlockPublicAccess, Bucket, IBucket } from 'aws-cdk-lib/aws-s3';
import {
  buildLibpqDsn,
  buildPostgresUri,
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  PORTS,
} from '../common/config';
import {
  DEV_RAW_SIGNAL_EXPIRATION_DAYS,
  DEV_RDS_ALLOCATED_STORAGE_GIB,
  DEV_RDS_INSTANCE_TYPE,
} from './config';

/**
 * `TOKEN_HASH_SECRET` 길이. HMAC-SHA256 키이므로 출력 길이(32바이트)보다 길면
 * 추가 이득이 없지만, 영숫자 문자당 엔트로피가 약 5.95비트라 64자여야 여유 있게
 * 256비트를 넘긴다. (ADR-0023)
 */
const TOKEN_HASH_SECRET_LENGTH = 64;

export interface DevDataStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly rdsSecurityGroup: ISecurityGroup;
}

/**
 * DevDataStack: RDS PostgreSQL 단일 인스턴스(컨트롤 플레인) + Raw Signal S3 버킷.
 *
 * 운영은 Aurora Serverless v2 지만 dev 는 `DatabaseInstance` 다 (ADR-0022 6번).
 * 최소 0.5 ACU 상시 과금이 개발용으로 과하고, 이 선택의 목적인
 * `publiclyAccessible` 직접 접속에는 단일 인스턴스가 더 단순하기 때문이다.
 * **앱이 보는 계약(PostgreSQL 16, `controlplane`, `sslmode=require`)은 운영과
 * 같으므로 잃는 것이 없다.**
 *
 * `CfnOutput` 은 여기서 만들지 않는다. 출력은 `DevEdgeStack` 한 곳에 모으고
 * 이 스택은 endpoint/secret ARN 을 public getter 로만 노출한다.
 */
export class DevDataStack extends Stack {
  public readonly database: DatabaseInstance;
  /** DatabaseInstance 가 Secrets Manager 에 자동 생성한 시크릿 (참조만; 값 접근 금지). */
  public readonly dbSecret: ISecret;
  /**
   * post-processor 전용 파생 시크릿. 값은 libpq keyword/value DSN 한 줄이며
   * ECS 가 `ENRICHMENT_PG_DSN` 으로 주입한다. (ADR-0018, ADR-0022 7번)
   */
  public readonly postProcessorPgDsnSecret: ISecret;
  /**
   * auth-proxy 전용 파생 시크릿. 값은 **URI 형식** DSN 한 줄이며 ECS 가
   * `DATABASE_URL` 로 주입한다. 위 `postProcessorPgDsnSecret` 과 형식이 다른 이유는
   * `buildPostgresUri()` 주석에 있다. (ADR-0023)
   */
  public readonly authProxyDatabaseUrlSecret: ISecret;
  /**
   * auth-proxy 의 Bearer 토큰 HMAC-SHA256 키. **enrollment 서버와 공유하는 값이다.**
   * 토큰 발급 측이 같은 키로 해시해야 조회가 성립한다. (ADR-0023)
   */
  public readonly tokenHashSecret: ISecret;
  public readonly rawSignalBucket: IBucket;

  constructor(scope: Construct, id: string, props: DevDataStackProps) {
    super(scope, id, props);

    this.database = new DatabaseInstance(this, 'DevPostgres', {
      // 엔진과 마이너 버전은 운영(ADR-0012)과 같은 16.13 으로 고정한다. 앱이 보는
      // 계약이 갈라지면 "dev 에서 검증했다"가 운영에 대해 아무것도 보장하지 못한다.
      engine: DatabaseInstanceEngine.postgres({
        version: PostgresEngineVersion.VER_16_13,
      }),
      instanceType: DEV_RDS_INSTANCE_TYPE,
      vpc: props.vpc,
      // 퍼블릭 서브넷 + publiclyAccessible 이 이 선택의 목적이다 - 로컬에서 psql 로
      // 직접 붙어 스키마를 만들고 데이터를 확인할 수 있어야 한다. 접근 통제는
      // 전적으로 `DevRdsSg` 의 허용 CIDR 에 달려 있다. (ADR-0022 6번)
      vpcSubnets: { subnetType: SubnetType.PUBLIC },
      publiclyAccessible: true,
      securityGroups: [props.rdsSecurityGroup],
      // `control` 은 RDS 가 엔진 예약어로 거부한다. 운영과 같은 상수를 쓴다. (ADR-0012)
      databaseName: CONTROL_DB_NAME,
      credentials: Credentials.fromGeneratedSecret('postgres'),
      allocatedStorage: DEV_RDS_ALLOCATED_STORAGE_GIB,
      storageType: StorageType.GP3,
      // availabilityZone 을 명시하지 않는다. DB subnet group 이 2 AZ 이므로 RDS 가
      // 고르게 둔다 - dev 에는 운영의 `PRIMARY_AZ_INDEX` 같은 AZ 고정 요구가 없다.
      multiAz: false,
      backupRetention: Duration.days(0), // dev - 스냅샷 비용/시간 없이 즉시 재생성
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // 마스터 시크릿은 참조(ISecret)만 노출한다. 합성 시점에 값을 평문으로 읽어
    // 다른 리소스 속성에 박는 코드는 두지 않는다.
    //
    // 예외는 단 하나, 바로 아래 파생 DSN 시크릿이다. 거기서도 실제로 오가는 것은
    // `{{resolve:secretsmanager:...}}` 동적 참조 토큰이지 평문이 아니다.
    // 새 예외를 만들려면 ADR-0018 을 먼저 갱신한다.
    this.dbSecret = this.database.secret!;

    // post-processor(ai-telemetry-pipeline)는 접속 정보를 조각으로 받지 못한다.
    // libpq DSN 문자열 하나(ENRICHMENT_PG_DSN)만 읽는다(src/enrichment/rds.py:21).
    // 그래서 여기서 조립한 파생 시크릿을 만들고 DevApplicationStack 이 ECS `secrets`
    // 로 주입한다 - 그래야 평문 DSN 이 `aws ecs describe-task-definition` 과 ECS
    // 콘솔에 남지 않는다. **운영과 형식이 갈리면 post-processor 가 dev 에서만
    // 다르게 동작하므로 구조를 그대로 재현한다.** (ADR-0018, ADR-0022 7번)
    //
    // unsafeUnwrap() 은 평문을 꺼내는 함수가 아니다. cdk.json 의
    // `@aws-cdk/core:checkSecretUsage` 가 건 합성 가드를 해제할 뿐이고(안 부르면
    // `Resolution error` 로 synth 가 실패한다), 반환값은
    // `{{resolve:secretsmanager:<arn>:SecretString:password::}}` 토큰 문자열이다.
    // 합성 산출물에는 Fn::Join / Fn::GetAtt / 동적 참조만 남는다.
    //
    // **우연한 커플링 주의.** `buildLibpqDsn()` 은 값을 따옴표로 감싸지 않는다 -
    // 합성 시점에 user/password 는 토큰이라 감쌀 방법이 없다. aws-rds 의
    // `DEFAULT_PASSWORD_EXCLUDE_CHARS` 가 공백·`'`·`"`·`\` 넷을 전부 빼주기
    // 때문에만 성립한다. `DatabaseInstance` 도 `DatabaseCluster` 와 같은 상수를
    // 쓰지만 **그 상수는 공개 export 가 아니라 상수 import 로 검증할 수 없다.**
    // 깨지면 배포는 성공하고 post-processor 만 런타임에 죽으므로,
    // `test/dev/data-stack.test.ts` 가 합성 템플릿의 `ExcludeCharacters` 문자열로
    // 고정한다. (ADR-0018, ADR-0022 7번)
    const pgDsn = buildLibpqDsn({
      host: this.database.dbInstanceEndpointAddress,
      // dbInstanceEndpointPort 는 문자열 토큰이라 보간이 불안정하다. 인스턴스에
      // port 를 주지 않았으므로 엔진 기본값이고, 이 값은 DevNetworkStack 의 RDS
      // ingress 룰과 같은 상수여야 한다. (상수 이름이 aurora 인 것은 기존 명명이다)
      port: PORTS.aurora,
      // 자동 생성 시크릿에는 dbname 키가 없으므로 직접 넣는다.
      dbname: CONTROL_DB_NAME,
      user: this.dbSecret.secretValueFromJson('username').unsafeUnwrap(),
      password: this.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
      sslmode: CONTROL_DB_SSLMODE,
    });

    this.postProcessorPgDsnSecret = new Secret(this, 'DevPostProcessorPgDsn', {
      description:
        'libpq DSN for dev post-processor (ENRICHMENT_PG_DSN). Derived from the RDS master secret at deploy time.',
      secretStringValue: SecretValue.unsafePlainText(pgDsn),
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // auth-proxy 는 같은 DB 를 보지만 **형식이 다른** DSN 을 읽는다 (ADR-0023).
    // psycopg 는 libpq keyword/value 를, `pg` 는 URI 를 받는다. 같은 조각으로 두 문자열을
    // 만드는 것이지 둘 중 하나가 잉여인 것이 아니다. 자세한 근거와 `uselibpqcompat`
    // 플래그의 필요성은 `buildPostgresUri()` 주석에 있다.
    const authProxyDatabaseUrl = buildPostgresUri({
      host: this.database.dbInstanceEndpointAddress,
      port: PORTS.aurora,
      dbname: CONTROL_DB_NAME,
      user: this.dbSecret.secretValueFromJson('username').unsafeUnwrap(),
      password: this.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
      sslmode: CONTROL_DB_SSLMODE,
    });

    this.authProxyDatabaseUrlSecret = new Secret(
      this,
      'DevAuthProxyDatabaseUrl',
      {
        description:
          'Postgres URI for dev auth-proxy (DATABASE_URL). Derived from the RDS master secret at deploy time.',
        secretStringValue: SecretValue.unsafePlainText(authProxyDatabaseUrl),
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

    // Bearer 토큰 해시 키. **값을 CDK 가 만들고 아무 데도 기록하지 않는다** - 코드에도,
    // CFN 템플릿에도, cdk context 에도 남지 않고 Secrets Manager 안에서만 존재한다.
    //
    // enrollment 서버(별도 레포)가 토큰 발급 시 같은 키로 HMAC 해시해야 auth-proxy 의
    // 조회가 성립하므로, ARN 을 `DevEdgeStack` 의 CfnOutput 으로 노출한다.
    //
    // **회전을 설정하지 않는다.** 이 키가 바뀌면 이미 발급된 모든 토큰의 `token_hash` 가
    // 매칭 불가가 되어 전 클라이언트가 401 을 받는다. 회전하려면 토큰 전량 재발급이나
    // 이중 키 검증이 선행되어야 한다 (ADR-0023 Follow-up).
    this.tokenHashSecret = new Secret(this, 'DevAuthProxyTokenHashSecret', {
      description:
        'HMAC-SHA256 key for dev auth-proxy telemetry token hashing (TOKEN_HASH_SECRET). Shared with the enrollment server.',
      generateSecretString: {
        passwordLength: TOKEN_HASH_SECRET_LENGTH,
        // 영숫자만 남긴다. 이 값은 환경변수로 셸을 거치지 않고 ECS 가 직접 주입하지만,
        // 운영자가 CLI 로 꺼내 다룰 때 인용 실수가 나지 않게 한다.
        excludePunctuation: true,
        excludeUppercase: false,
        includeSpace: false,
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    this.rawSignalBucket = new Bucket(this, 'DevRawSignalBucket', {
      // bucketName 을 주지 않는다. CDK 가 스택명에서 이름을 유도하므로 운영 버킷과
      // 자동으로 갈린다 - S3 이름은 전역 유일이라 이 자동 분리가 방어선이다.
      // (ADR-0021 Constraints)
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      // dev 데이터는 재현용이라 운영(30일)보다 짧게 만료시킨다.
      lifecycleRules: [
        { expiration: Duration.days(DEV_RAW_SIGNAL_EXPIRATION_DAYS) },
      ],
      // 운영 버킷에는 없는 항목이다. dev VPC 는 퍼블릭 서브넷 전용이라 평문 HTTP
      // 접근 경로가 실제로 존재하므로 여기서만 추가로 막는다.
      enforceSSL: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }

  /** RDS 엔드포인트 호스트명. DevEdgeStack 의 CfnOutput 용. */
  public get dbEndpoint(): string {
    return this.database.dbInstanceEndpointAddress;
  }

  /** 마스터 시크릿 ARN. 로컬 psql 접속 시 값을 꺼내오는 출발점이다. */
  public get dbSecretArn(): string {
    return this.dbSecret.secretArn;
  }

  /**
   * 토큰 해시 키 ARN. **enrollment 서버에 전달할 값이다** - 그쪽이 같은 키로 해시해야
   * auth-proxy 의 조회가 성립한다. `DevEdgeStack` 의 CfnOutput 용. (ADR-0023)
   */
  public get tokenHashSecretArn(): string {
    return this.tokenHashSecret.secretArn;
  }
}
