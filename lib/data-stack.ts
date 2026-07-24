import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraPostgresEngineVersion,
  ClusterInstance,
  DatabaseCluster,
  DatabaseClusterEngine,
} from 'aws-cdk-lib/aws-rds';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import {
  BlockPublicAccess,
  Bucket,
  IBucket,
} from 'aws-cdk-lib/aws-s3';
import {
  CONTROL_DB_NAME,
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
  public readonly rawSignalBucket: IBucket;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    this.aurora = new DatabaseCluster(this, 'Aurora', {
      engine: DatabaseClusterEngine.auroraPostgres({
        version: AuroraPostgresEngineVersion.VER_16_6,
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

    // 시크릿은 참조만 노출한다. 값을 읽는 코드는 절대 두지 않는다.
    this.dbSecret = this.aurora.secret!;

    this.rawSignalBucket = new Bucket(this, 'RawSignalBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: Duration.days(30) }],
      autoDeleteObjects: true, // MVP
      removalPolicy: RemovalPolicy.DESTROY,
    });
  }
}
