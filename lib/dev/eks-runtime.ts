import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

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
}

/** ADR-0028: 기존 Secret 참조와 검증 단계의 쓰기 범위만 EKS에 연결한다. */
export class DevEksRuntime extends Construct {
  public readonly enrollmentRole: Role;
  public readonly telemetryIngestRole: Role;
  public readonly dashboardRole: Role;
  public readonly fluentBitRole: Role;
  public readonly applicationLogGroup: LogGroup;

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
      // EKS values의 활성화는 ECS enabled와 독립적이다. 선언된 원본만 미리 허용한다.
      ...Object.values(props.oidcClientSecrets ?? {}),
    ]);
    this.grantSecretRead(this.telemetryIngestRole, [props.dbSecret, props.tokenHashSecret]);

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
      ApplicationLogGroupName: this.applicationLogGroup.logGroupName,
      ArchivePrefix: props.archivePrefix,
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
