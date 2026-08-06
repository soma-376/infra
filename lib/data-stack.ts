import {
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  StackProps,
} from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from 'aws-cdk-lib/aws-rds';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  BlockPublicAccess,
  Bucket,
  IBucket,
} from 'aws-cdk-lib/aws-s3';
import {
  buildLibpqDsn,
  CONTROL_DB_NAME,
  CONTROL_DB_SSLMODE,
  PORTS,
  PRIMARY_AZ_INDEX,
  SUBNET_GROUP,
} from './config';

export interface DataStackProps extends StackProps {
  readonly vpc: IVpc;
  readonly auroraSecurityGroup: ISecurityGroup;
}

/**
 * DataStack: Aurora Serverless v2(컨트롤 플레인) + Raw Signal S3 버킷.
 */
export class DataStack extends Stack {
  public readonly aurora: DatabaseCluster;
  /** DatabaseCluster 가 Secrets Manager 에 자동 생성한 시크릿 (참조만; 값 접근 금지). */
  public readonly dbSecret: ISecret;
  /**
   * post-processor 전용 파생 시크릿. 값은 libpq keyword/value DSN 한 줄이며
   * ECS 가 `ENRICHMENT_PG_DSN` 으로 주입한다. (ADR-0018)
   */
  public readonly postProcessorPgDsnSecret: ISecret;
  public readonly rawSignalBucket: IBucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.aurora = new DatabaseCluster(this, 'Aurora', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_13,
      }),
      writer: ClusterInstance.serverlessV2('Writer', {
        // DB subnet group은 2 AZ를 유지하되 writer는 MVP primary AZ에 고정한다.
        availabilityZone: props.vpc.availabilityZones[PRIMARY_AZ_INDEX],
      }),
      serverlessV2MinCapacity: 0.5, // MVP 비용 최소화
      serverlessV2MaxCapacity: 2,
      vpc: props.vpc,
      vpcSubnets: { subnetGroupName: SUBNET_GROUP.db },
      securityGroups: [props.auroraSecurityGroup],
      defaultDatabaseName: CONTROL_DB_NAME,
      removalPolicy: RemovalPolicy.DESTROY, // MVP
    });

    // Aurora 마스터 시크릿은 참조(ISecret)만 노출한다. CDK 가 값을 읽어 다른 리소스
    // 속성에 평문으로 박는 코드는 두지 않는다.
    //
    // 예외는 단 하나, 바로 아래 파생 DSN 시크릿이다. 거기서도 실제로 오가는 것은
    // `{{resolve:secretsmanager:...}}` 동적 참조 토큰이지 평문이 아니다.
    // 새 예외를 만들려면 ADR-0018 을 먼저 갱신한다.
    this.dbSecret = this.aurora.secret!;

    // post-processor(ai-telemetry-pipeline)는 접속 정보를 조각으로 받지 못한다.
    // libpq DSN 문자열 하나(ENRICHMENT_PG_DSN)만 읽는다(src/enrichment/rds.py:21).
    // 그래서 여기서 조립한 파생 시크릿을 만들고 ApplicationStack 이 ECS `secrets`
    // 로 주입한다 - 그래야 평문 DSN 이 `aws ecs describe-task-definition` 과 ECS
    // 콘솔에 남지 않는다. (ADR-0018)
    //
    // unsafeUnwrap() 은 평문을 꺼내는 함수가 아니다. cdk.json 의
    // `@aws-cdk/core:checkSecretUsage` 가 건 합성 가드를 해제할 뿐이고(안 부르면
    // `Resolution error` 로 synth 가 실패한다), 반환값은
    // `{{resolve:secretsmanager:<arn>:SecretString:password::}}` 토큰 문자열이다.
    // 합성 산출물에는 Fn::Join / Fn::GetAtt / 동적 참조만 남는다.
    const pgDsn = buildLibpqDsn({
      host: this.aurora.clusterEndpoint.hostname,
      // clusterEndpoint.port 는 number 토큰이라 문자열 보간이 불안정하다.
      // DatabaseCluster 에 port 를 주지 않았으므로 엔진 기본값이고, 이 값은
      // lib/network-stack.ts 의 Aurora ingress 룰과 같은 상수여야 한다.
      port: PORTS.aurora,
      // DB_CREDS 시크릿과 마찬가지로 여기에도 dbname 이 없으므로 직접 넣는다.
      dbname: CONTROL_DB_NAME,
      user: this.dbSecret.secretValueFromJson('username').unsafeUnwrap(),
      password: this.dbSecret.secretValueFromJson('password').unsafeUnwrap(),
      sslmode: CONTROL_DB_SSLMODE,
    });

    this.postProcessorPgDsnSecret = new Secret(this, 'PostProcessorPgDsn', {
      description:
        'libpq DSN for post-processor (ENRICHMENT_PG_DSN). Derived from the Aurora master secret at deploy time.',
      secretStringValue: SecretValue.unsafePlainText(pgDsn),
      removalPolicy: RemovalPolicy.DESTROY, // MVP
    });

    this.rawSignalBucket = new Bucket(this, 'RawSignalBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      autoDeleteObjects: true, // MVP
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
