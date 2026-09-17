import {
  Duration,
  RemovalPolicy,
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
  CONTROL_DB_NAME,
  ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
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

/**
 * dev enrollment-api 정적 관리자 토큰 길이.
 *
 * backend 계약은 빈 값만 금지하고 길이는 강제하지 않는다. 현재 생성 문자집합인
 * 영문 대·소문자와 숫자 62종은 문자당 약 5.95비트이므로 64자는 약 381비트의
 * 엔트로피를 갖는다. 256비트에 필요한 43자보다 여유 있게 잡은 dev 운영 정책이며,
 * SHA-256 hex 출력 길이나 위 `TOKEN_HASH_SECRET_LENGTH`에서 유도된 값은 아니다.
 */
const ADMIN_API_TOKEN_LENGTH = 64;

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
   * telemetry-ingest 와 enrollment-api 가 공유하는 Bearer 토큰 HMAC-SHA256 키.
   * 토큰 발급 측과 검증 측이 같은 키를 써야 조회가 성립한다. (ADR-0026)
   */
  public readonly tokenHashSecret: ISecret;
  /** enrollment-api 의 정적 관리자 API 토큰. JSON `token` 필드로 저장한다. */
  public readonly adminApiTokenSecret: ISecret;
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
    this.dbSecret = this.database.secret!;

    // Bearer 토큰 해시 키. **값을 CDK 가 만들고 아무 데도 기록하지 않는다** - 코드에도,
    // CFN 템플릿에도, cdk context 에도 남지 않고 Secrets Manager 안에서만 존재한다.
    //
    // enrollment-api 가 토큰 발급 시 같은 키로 HMAC 해시해야 telemetry-ingest 의
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

    // enrollment-api 의 관리자 엔드포인트 인증 토큰. 값은 CDK/CloudFormation 출력에
    // 기록하지 않고 Secrets Manager 가 배포 시 생성한다. ECS 에는 JSON `token` 필드만
    // 주입한다. dev MVP 정책에 따라 기본 암호화, 무회전, DESTROY 를 유지한다.
    this.adminApiTokenSecret = new Secret(
      this,
      'DevEnrollmentAdminApiToken',
      {
        description:
          'Static admin API token for dev enrollment-api (PULSEMETRY_ADMIN_API_TOKEN).',
        generateSecretString: {
          secretStringTemplate: '{}',
          generateStringKey: ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY,
          passwordLength: ADMIN_API_TOKEN_LENGTH,
          excludePunctuation: true,
          excludeUppercase: false,
          includeSpace: false,
        },
        removalPolicy: RemovalPolicy.DESTROY,
      },
    );

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
   * 토큰 해시 키 ARN. telemetry-ingest 와 enrollment-api 가 같은 키를 쓴다.
   * `DevEdgeStack` 의 CfnOutput 용. (ADR-0026)
   */
  public get tokenHashSecretArn(): string {
    return this.tokenHashSecret.secretArn;
  }

  /** 관리자 API 토큰 Secret ARN. 값은 출력하지 않는다. */
  public get adminApiTokenSecretArn(): string {
    return this.adminApiTokenSecret.secretArn;
  }
}
