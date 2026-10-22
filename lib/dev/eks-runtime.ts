import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { DEV_EKS_NAMESPACE, DEV_EKS_TELEMETRY_SERVICE_ACCOUNTS, DEV_EKS_TELEMETRY_SESSION_NAMES } from './eks-config';

export interface DevEksRuntimeProps {
  readonly clusterName: string;
  readonly dbSecret: ISecret;
  readonly tokenHashSecret: ISecret;
  readonly adminApiTokenSecret: ISecret;
  readonly dashboardRdsSourceSecret: ISecret;
  readonly dashboardRdsCacheSecret: ISecret;
  readonly dashboardClickHouseSourceSecret: ISecret;
  readonly dashboardClickHouseCacheSecret: ISecret;
  readonly userJwtPrivateKeySecret: ISecret;
  readonly userJwtPublicKeysSecret: ISecret;
  readonly oidcClientSecrets?: Readonly<Record<string, ISecret>>;
  readonly rawSignalBucket: IBucket;
  readonly archivePrefix: 'eks_validation' | 'eks';
  /** telemetry 전용 JWT 원본. 개인키는 enrollment만 읽는다. (ADR-0036) */
  readonly telemetryJwtPrivateKeySecret: ISecret;
  readonly telemetryJwtPublicKeysSecret: ISecret;
  /** MSK 데이터 권한의 리소스 ARN. stage topic/group 하나씩만 허용한다. (ADR-0036) */
  readonly msk: DevEksRuntimeMskTargets;
}

export interface DevEksRuntimeMskTargets {
  readonly clusterArn: string;
  readonly topicArn: string;
  readonly consumerGroupArn: string;
}

/** ADR-0028: 기존 Secret 참조와 검증 단계의 쓰기 범위만 EKS에 연결한다. */
export class DevEksRuntime extends Construct {
  public readonly enrollmentRole: Role;
  public readonly telemetryIngestRole: Role;
  public readonly dashboardRole: Role;
  public readonly fluentBitRole: Role;
  public readonly applicationLogGroup: LogGroup;
  public readonly telemetryGatewayRole: Role;
  public readonly telemetryKafkaAdminRole: Role;
  public readonly telemetryKafkaOffsetsRole: Role;
  /** workload별 MSK 전용 역할. 해당 Pod 역할만 고정 세션 이름으로 assume한다. */
  public readonly mskRoles: Readonly<Record<keyof typeof DEV_EKS_TELEMETRY_SESSION_NAMES, Role>>;

  constructor(scope: Construct, id: string, props: DevEksRuntimeProps) {
    super(scope, id);
    // 타입 검사를 우회한 context도 버킷 전체나 잘못된 prefix를 열 수 없다.
    if (!['eks_validation', 'eks'].includes(props.archivePrefix)) {
      throw new Error('EKS archivePrefix는 eks_validation 또는 eks여야 한다.');
    }

    this.enrollmentRole = this.podRole(
      'Enrollment', props.clusterName, 'pulsemetry-dev', 'enrollment-api',
    );
    this.telemetryIngestRole = this.podRole(
      'TelemetryIngest', props.clusterName, 'pulsemetry-dev', 'telemetry-ingest',
    );
    this.grantSecretRead(this.enrollmentRole, [
      props.dbSecret, props.tokenHashSecret, props.adminApiTokenSecret,
      props.userJwtPrivateKeySecret, props.userJwtPublicKeysSecret,
      // EKS runtime YAML의 활성화와 CDK key 선언은 독립적이다. 선언된 원본만 미리 허용한다.
      ...Object.values(props.oidcClientSecrets ?? {}),
      // telemetry JWT 서명은 enrollment만 한다. 개인키 원본은 이 역할에만 연결한다. (ADR-0036)
      props.telemetryJwtPrivateKeySecret, props.telemetryJwtPublicKeysSecret,
    ]);
    // 전환·복구용 HTTP JWT 호환을 위해 ingest는 telemetry 공개키만 추가로 읽는다. 사용자 JWT는 받지 않는다.
    this.grantSecretRead(this.telemetryIngestRole, [props.dbSecret, props.tokenHashSecret, props.telemetryJwtPublicKeysSecret]);

    this.dashboardRole = this.podRole(
      'Dashboard', props.clusterName, 'pulsemetry-dev', 'dashboard-api',
    );
    this.grantSecretRead(this.dashboardRole, [
      props.dashboardRdsSourceSecret, props.dashboardRdsCacheSecret,
      props.dashboardClickHouseSourceSecret, props.dashboardClickHouseCacheSecret,
      props.userJwtPublicKeysSecret,
    ]);

    // grantWrite()는 multipart/삭제 등 불필요한 동작까지 넓히므로 PutObject만 선언한다.
    this.telemetryIngestRole.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [props.rawSignalBucket.arnForObjects(`${props.archivePrefix}/*`)],
      conditions: { Bool: { 'aws:SecureTransport': 'true' } },
    }));

    // Gateway는 DB·HMAC·관리 token·사용자 JWT·개인키·S3 없이 telemetry 공개키와 MSK 쓰기만 갖는다. (ADR-0036)
    const accounts = DEV_EKS_TELEMETRY_SERVICE_ACCOUNTS;
    this.telemetryGatewayRole = this.podRole('TelemetryGateway', props.clusterName, DEV_EKS_NAMESPACE, accounts.gateway);
    this.grantSecretRead(this.telemetryGatewayRole, [props.telemetryJwtPublicKeysSecret]);
    // 관리 Job은 Secret 없이 각자의 MSK 역할만 assume한다.
    this.telemetryKafkaAdminRole = this.podRole('TelemetryKafkaAdmin', props.clusterName, DEV_EKS_NAMESPACE, accounts.topicAdmin);
    this.telemetryKafkaOffsetsRole = this.podRole('TelemetryKafkaOffsets', props.clusterName, DEV_EKS_NAMESPACE, accounts.offsetAdmin);

    const { clusterArn, topicArn, consumerGroupArn } = props.msk;
    const kafka = (resource: string, ...actions: string[]) => new PolicyStatement({
      actions: actions.map(action => `kafka-cluster:${action}`), resources: [resource],
    });
    const sessions = DEV_EKS_TELEMETRY_SESSION_NAMES;
    this.mskRoles = {
      gateway: this.mskRole('Gateway', this.telemetryGatewayRole, accounts.gateway, sessions.gateway, [
        kafka(clusterArn, 'Connect', 'WriteDataIdempotently'),
        kafka(topicArn, 'DescribeTopic', 'WriteData'),
      ]),
      ingest: this.mskRole('Ingest', this.telemetryIngestRole, 'telemetry-ingest', sessions.ingest, [
        kafka(clusterArn, 'Connect'),
        kafka(topicArn, 'DescribeTopic', 'ReadData'),
        kafka(consumerGroupArn, 'DescribeGroup', 'AlterGroup'),
      ]),
      topicAdmin: this.mskRole('TopicAdmin', this.telemetryKafkaAdminRole, accounts.topicAdmin, sessions.topicAdmin, [
        kafka(clusterArn, 'Connect'),
        kafka(topicArn, 'CreateTopic', 'DescribeTopic', 'DescribeTopicDynamicConfiguration', 'AlterTopicDynamicConfiguration'),
      ]),
      offsetAdmin: this.mskRole('OffsetAdmin', this.telemetryKafkaOffsetsRole, accounts.offsetAdmin, sessions.offsetAdmin, [
        kafka(clusterArn, 'Connect'),
        kafka(consumerGroupArn, 'DescribeGroup', 'AlterGroup'),
        kafka(topicArn, 'DescribeTopic', 'ReadData'),
      ]),
    };

    this.applicationLogGroup = new LogGroup(this, 'ApplicationLogs', {
      logGroupName: '/eks/dev/application',
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.fluentBitRole = this.podRole(
      'FluentBit', props.clusterName, 'pulsemetry-dev-logs', 'fluent-bit',
    );
    this.fluentBitRole.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
      resources: [this.applicationLogGroup.logGroupArn],
    }));

    // 값이 아닌 역할·로그 그룹·prefix 참조만 출력한다.
    for (const [name, value] of Object.entries({
      RuntimeEnrollmentRoleArn: this.enrollmentRole.roleArn,
      RuntimeTelemetryIngestRoleArn: this.telemetryIngestRole.roleArn,
      RuntimeDashboardRoleArn: this.dashboardRole.roleArn,
      RuntimeFluentBitRoleArn: this.fluentBitRole.roleArn,
      RuntimeTelemetryGatewayRoleArn: this.telemetryGatewayRole.roleArn,
      RuntimeTelemetryKafkaAdminRoleArn: this.telemetryKafkaAdminRole.roleArn,
      RuntimeTelemetryKafkaOffsetsRoleArn: this.telemetryKafkaOffsetsRole.roleArn,
      ApplicationLogGroupName: this.applicationLogGroup.logGroupName,
      ArchivePrefix: props.archivePrefix,
      // 앱·Job이 aws-msk-iam-auth의 awsRoleArn·awsRoleSessionName으로 사용한다.
      MskGatewayRoleArn: this.mskRoles.gateway.roleArn,
      MskIngestRoleArn: this.mskRoles.ingest.roleArn,
      MskTopicAdminRoleArn: this.mskRoles.topicAdmin.roleArn,
      MskOffsetAdminRoleArn: this.mskRoles.offsetAdmin.roleArn,
      MskGatewaySessionName: sessions.gateway,
      MskIngestSessionName: sessions.ingest,
      MskTopicAdminSessionName: sessions.topicAdmin,
      MskOffsetAdminSessionName: sessions.offsetAdmin,
    })) {
      const output = new CfnOutput(this, name, { value });
      output.overrideLogicalId(name);
    }
  }

  private podRole(id: string, clusterName: string, namespace: string, serviceAccount: string): Role {
    const role = new Role(this, `${id}Role`, {
      description: `Dev EKS Pod Identity for ${serviceAccount}`,
      assumedBy: new ServicePrincipal('pods.eks.amazonaws.com')
        .withSessionTags()
        .withConditions({
          StringEquals: {
            'aws:RequestTag/eks-cluster-name': clusterName,
            'aws:RequestTag/kubernetes-namespace': namespace,
            'aws:RequestTag/kubernetes-service-account': serviceAccount,
          },
        }),
    });
    new CfnPodIdentityAssociation(this, `${id}Association`, {
      clusterName,
      namespace,
      serviceAccount,
      roleArn: role.roleArn,
      disableSessionTags: false,
    });
    return role;
  }

  /**
   * Pod Identity 자격은 갱신마다 세션 이름이 바뀔 수 있어 MSK 재인증이 거부된다. 앱은 이 역할을 고정 세션
   * 이름으로 assume한다. Pod Identity session tag는 transitive이므로 trust에 sts:TagSession이 필요하다.
   * 신뢰 주체는 대응 Pod 역할 하나뿐이다. (ADR-0036)
   */
  private mskRole(id: string, podRole: Role, serviceAccount: string, sessionName: string, statements: PolicyStatement[]): Role {
    const principal = new ArnPrincipal(podRole.roleArn);
    const role = new Role(this, `${id}MskRole`, {
      description: `Dev MSK data access for ${serviceAccount}`,
      assumedBy: principal.withConditions({ StringEquals: { 'sts:RoleSessionName': sessionName } }),
    });
    role.assumeRolePolicy!.addStatements(new PolicyStatement({ actions: ['sts:TagSession'], principals: [principal] }));
    for (const statement of statements) role.addToPolicy(statement);
    podRole.addToPolicy(new PolicyStatement({ actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [role.roleArn] }));
    return role;
  }

  private grantSecretRead(role: Role, secrets: ISecret[]): void {
    role.addToPolicy(new PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: secrets.map(secret => secret.secretArn),
      conditions: { Bool: { 'aws:SecureTransport': 'true' } },
    }));
    // 기존 AWS managed key Secret에는 추가 KMS 권한이 필요 없다.
    for (const secret of secrets) {
      if (secret.encryptionKey) secret.encryptionKey.grantDecrypt(role);
    }
  }
}
