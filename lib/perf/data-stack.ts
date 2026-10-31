import { ArnFormat, CfnOutput, Duration, Fn, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { ISecurityGroup, ISubnet, IVpc, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { LogGroup } from 'aws-cdk-lib/aws-logs';
import { CfnCluster, CfnConfiguration } from 'aws-cdk-lib/aws-msk';
import {
  Credentials, DatabaseInstance, DatabaseInstanceEngine, PostgresEngineVersion, StorageType,
} from 'aws-cdk-lib/aws-rds';
import { BlockPublicAccess, Bucket, BucketEncryption, IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnSecret, ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { CONTROL_DB_NAME, ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY } from '../common/config';
import { PERF_DB_USERS, PERF_MSK, perfSecretName } from './config';
import { PerfProfile } from './profile';
import { perfLogRetention } from './retention';

export interface PerfDataStackProps extends StackProps {
  readonly environmentId: string;
  readonly profile: PerfProfile;
  readonly mskBrokerVolumeGiB: number;
  readonly vpc: IVpc;
  readonly dataSubnets: readonly ISubnet[];
  readonly mskSubnets: readonly ISubnet[];
  readonly rdsSecurityGroup: ISecurityGroup;
  readonly mskSecurityGroup?: ISecurityGroup;
}

/** dev와 같은 생성 길이다. HMAC·관리 token은 영숫자 64자(약 381비트)다. */
const GENERATED_SECRET_LENGTH = 64;

/**
 * PerfDataStack: RDS·MSK·raw signal bucket과 환경 Secret 원본. 환경과 함께 지운다.
 *
 * Secret 이름에 environment ID를 넣어 지운 환경의 이름과 충돌하지 않게 한다. 값은 서버 측 생성이거나(DB·HMAC·관리
 * token·seed secret·Grafana) 운영자가 등록한다(telemetry JWT 키). 사용자 JWT·OIDC·dashboard 원본은 만들지 않는다.
 */
export class PerfDataStack extends Stack {
  public readonly database: DatabaseInstance;
  public readonly dbSecret: ISecret;
  public readonly tokenHashSecret: ISecret;
  public readonly adminApiTokenSecret: ISecret;
  public readonly telemetryJwtPrivateKeySecret: ISecret;
  public readonly telemetryJwtPublicKeysSecret: ISecret;
  public readonly syntheticSeedSecret: ISecret;
  public readonly seedDbSecret: ISecret;
  public readonly verifyDbSecret: ISecret;
  public readonly grafanaAdminSecret: ISecret;
  public readonly rawSignalBucket: IBucket;
  public readonly msk?: CfnCluster;
  public readonly mskLogGroup?: LogGroup;
  public readonly topicArn?: string;
  public readonly consumerGroupArn?: string;

  constructor(scope: Construct, id: string, props: PerfDataStackProps) {
    super(scope, id, props);
    const { profile, environmentId } = props;
    const secretName = (name: string) => perfSecretName(environmentId, name);

    this.database = new DatabaseInstance(this, 'PerfPostgres', {
      engine: DatabaseInstanceEngine.postgres({ version: PostgresEngineVersion.VER_16_13 }),
      instanceType: new InstanceType(profile.rds.instance_class.replace(/^db\./, '')),
      vpc: props.vpc,
      vpcSubnets: { subnets: [...props.dataSubnets] },
      // 노드와 같은 AZ에 둔다. multi_az=false가 첫 프로필이다.
      availabilityZone: profile.availability_zone,
      multiAz: profile.rds.multi_az,
      publiclyAccessible: false,
      securityGroups: [props.rdsSecurityGroup],
      databaseName: CONTROL_DB_NAME,
      credentials: Credentials.fromGeneratedSecret('postgres', { secretName: secretName('rds/master') }),
      allocatedStorage: profile.rds.storage_gib,
      storageType: StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(0),
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.dbSecret = this.database.secret!;

    const generated = (constructId: string, name: string, description: string, template?: { key: string; base?: Record<string, string> }) => new Secret(this, constructId, {
      secretName: secretName(name),
      description,
      generateSecretString: {
        passwordLength: GENERATED_SECRET_LENGTH, excludePunctuation: true, includeSpace: false,
        ...(template ? { secretStringTemplate: JSON.stringify(template.base ?? {}), generateStringKey: template.key } : {}),
      },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.tokenHashSecret = generated('PerfTokenHashSecret', 'enrollment/token-hash-secret',
      'HMAC-SHA256 key for perf telemetry token hashing. Shared by enrollment-api and telemetry-ingest.');
    this.adminApiTokenSecret = generated('PerfEnrollmentAdminApiToken', 'enrollment/admin-token',
      'Static admin API token for perf enrollment-api.', { key: ENROLLMENT_ADMIN_API_TOKEN_SECRET_KEY });
    this.syntheticSeedSecret = generated('PerfSyntheticSeedSecret', 'synthetic/seed-secret',
      'Secret for deterministic perf synthetic identities and tokens.');
    // 실제 DB role·권한은 운영자가 런북으로 만든다. 여기서는 사용자 이름과 생성 비밀번호만 둔다.
    this.seedDbSecret = generated('PerfSeedDbSecret', 'rds/seed',
      'Credentials for the perf synthetic seed database role.', { key: 'password', base: { username: PERF_DB_USERS.seed } });
    this.verifyDbSecret = generated('PerfVerifyDbSecret', 'rds/verify',
      'Credentials for the perf handoff verification database role.', { key: 'password', base: { username: PERF_DB_USERS.verify } });
    this.grafanaAdminSecret = generated('PerfGrafanaAdmin', 'grafana/admin',
      'perf Grafana admin password, supplied through CSI only.', { key: 'password' });

    // telemetry JWT 키는 운영자가 첫 bootstrap에서 등록한다. 일반 재배포에서 키를 만들지 않는다(PLAN §4.3 3단계).
    const empty = (constructId: string, name: string, description: string) => {
      const resource = new CfnSecret(this, constructId, { name: secretName(name), description });
      resource.applyRemovalPolicy(RemovalPolicy.DESTROY);
      return Secret.fromSecretCompleteArn(this, `${constructId}Reference`, resource.ref);
    };
    this.telemetryJwtPrivateKeySecret = empty('PerfTelemetryJwtPrivateKeySecret', 'telemetry-jwt/private-key',
      'Versioned PKCS8 private key for perf telemetry JWT signing.');
    this.telemetryJwtPublicKeysSecret = empty('PerfTelemetryJwtPublicKeysSecret', 'telemetry-jwt/public-keys',
      'Versioned public key ring for perf telemetry JWT verification.');

    this.rawSignalBucket = new Bucket(this, 'PerfRawSignalBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(profile.retention.raw_signal_days), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    if (profile.msk) {
    if (!props.mskSecurityGroup) throw new Error('MSK SG가 필요하다');
    // MSK: dev와 같은 broker·topic 계약을 프로필 값으로 만든다. topic은 Helm 관리 Job이 만들고 대조한다.
    if (props.mskSubnets.length !== profile.msk.broker_count) {
      throw new Error(`MSK broker ${profile.msk.broker_count}대에는 서로 다른 AZ의 subnet ${profile.msk.broker_count}개가 필요하다`);
    }
    this.mskLogGroup = new LogGroup(this, 'MskBrokerLogs', {
      logGroupName: PERF_MSK.logGroupName,
      retention: perfLogRetention(profile.retention.cloudwatch_log_days),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const configuration = new CfnConfiguration(this, 'MskConfiguration', {
      name: PERF_MSK.configurationName,
      description: 'perf telemetry ingress broker settings',
      kafkaVersionsList: [profile.msk.kafka_version],
      serverProperties: Object.entries(perfMskServerProperties(profile)).map(([key, value]) => `${key}=${value}`).join('\n'),
    });
    this.msk = new CfnCluster(this, 'MskCluster', {
      clusterName: PERF_MSK.clusterName,
      kafkaVersion: profile.msk.kafka_version,
      numberOfBrokerNodes: profile.msk.broker_count,
      brokerNodeGroupInfo: {
        instanceType: profile.msk.instance_type,
        clientSubnets: props.mskSubnets.map(subnet => subnet.subnetId),
        securityGroups: [props.mskSecurityGroup.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: props.mskBrokerVolumeGiB } },
        connectivityInfo: { publicAccess: { type: 'DISABLED' } },
      },
      // IAM만 허용한다. 평문·SCRAM·TLS 인증서 인증 listener를 열지 않는다.
      clientAuthentication: { sasl: { iam: { enabled: true }, scram: { enabled: false } }, unauthenticated: { enabled: false } },
      encryptionInfo: { encryptionInTransit: { clientBroker: 'TLS', inCluster: true } },
      configurationInfo: { arn: configuration.attrArn, revision: configuration.attrLatestRevisionRevision },
      enhancedMonitoring: 'DEFAULT',
      openMonitoring: { prometheus: { jmxExporter: { enabledInBroker: true }, nodeExporter: { enabledInBroker: true } } },
      loggingInfo: { brokerLogs: { cloudWatchLogs: { enabled: true, logGroup: this.mskLogGroup.logGroupName } } },
    });
    const uuid = Fn.select(2, Fn.split('/', this.msk.attrArn));
    const dataArn = (resource: 'topic' | 'group', name: string) => this.formatArn({
      service: 'kafka', resource, resourceName: `${PERF_MSK.clusterName}/${uuid}/${name}`, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.topicArn = dataArn('topic', PERF_MSK.topic);
    this.consumerGroupArn = dataArn('group', PERF_MSK.consumerGroup);
    }

    // 값이 아닌 참조만 출력한다. 생성기가 이 output으로 values·결과 파일을 만든다.
    for (const [name, value] of Object.entries({
      DbEndpoint: this.database.dbInstanceEndpointAddress,
      DbInstanceArn: this.database.instanceArn,
      DbSecretArn: this.dbSecret.secretArn,
      TokenHashSecretArn: this.tokenHashSecret.secretArn,
      AdminApiTokenSecretArn: this.adminApiTokenSecret.secretArn,
      TelemetryJwtPrivateKeySecretArn: this.telemetryJwtPrivateKeySecret.secretArn,
      TelemetryJwtPublicKeysSecretArn: this.telemetryJwtPublicKeysSecret.secretArn,
      SyntheticSeedSecretArn: this.syntheticSeedSecret.secretArn,
      SeedDbSecretArn: this.seedDbSecret.secretArn,
      VerifyDbSecretArn: this.verifyDbSecret.secretArn,
      GrafanaAdminSecretArn: this.grafanaAdminSecret.secretArn,
      RawSignalBucketName: this.rawSignalBucket.bucketName,
      RawSignalBucketArn: this.rawSignalBucket.bucketArn,
      ...(this.msk && this.mskLogGroup ? {
      MskClusterArn: this.msk.attrArn,
      MskClusterName: PERF_MSK.clusterName,
      MskTopicName: PERF_MSK.topic,
      MskConsumerGroupName: PERF_MSK.consumerGroup,
      MskBrokerLogGroupName: this.mskLogGroup.logGroupName,
      } : { KafkaProvider: 'strimzi', KafkaClusterName: PERF_MSK.clusterName, KafkaTopicName: PERF_MSK.topic, KafkaConsumerGroupName: PERF_MSK.consumerGroup }),
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}

/** broker 설정. topic 관리 Job과 resolved `kafka`가 같은 값을 쓴다. */
export function perfMskServerProperties(profile: PerfProfile): Readonly<Record<string, string>> {
  const { msk } = profile;
  if (!msk) throw new Error('MSK 프로필이 필요하다');
  return {
    'auto.create.topics.enable': 'false',
    'default.replication.factor': String(msk.replication_factor),
    'min.insync.replicas': String(msk.min_insync_replicas),
    'num.partitions': String(msk.partitions),
    'unclean.leader.election.enable': 'false',
    'message.max.bytes': String(msk.max_message_bytes),
    'replica.fetch.max.bytes': String(msk.max_message_bytes),
    'log.retention.hours': String(msk.retention_hours),
  };
}
