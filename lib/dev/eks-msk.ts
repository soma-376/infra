import { ArnFormat, CfnOutput, Fn, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { ISecurityGroup, ISubnet } from 'aws-cdk-lib/aws-ec2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnCluster, CfnConfiguration } from 'aws-cdk-lib/aws-msk';
import { Construct } from 'constructs';
import {
  DEV_EKS_MSK, DEV_EKS_MSK_SERVER_PROPERTIES, DevTelemetryStage,
  devTelemetryConsumerGroupName, devTelemetryTopicName,
} from './eks-config';

export interface DevEksMskProps {
  /** 서로 다른 AZ의 MSK 전용 subnet 3개. Network가 소유한다. */
  readonly subnets: readonly ISubnet[];
  /** Network가 소유한 broker SG. 앱 node SG의 9098만 받는다. */
  readonly securityGroup: ISecurityGroup;
  readonly stage: DevTelemetryStage;
}

/**
 * telemetry ingress용 MSK Provisioned. topic은 만들지 않고 Helm 관리 Job이 생성·대조한다.
 * CFN에 bootstrap attribute가 없으므로 Lambda 조회 대신 운영자가 조회한 JSON을 생성기에 전달한다. (ADR-0035)
 */
export class DevEksMsk extends Construct {
  public readonly cluster: CfnCluster;
  public readonly configuration: CfnConfiguration;
  public readonly logGroup: LogGroup;
  public readonly clusterName: string = DEV_EKS_MSK.clusterName;
  public readonly topicName: string;
  public readonly consumerGroupName: string;
  /** IAM 데이터 권한의 리소스 ARN. cluster UUID는 attrArn에서만 얻는다. */
  public readonly topicArn: string;
  public readonly consumerGroupArn: string;

  constructor(scope: Construct, id: string, props: DevEksMskProps) {
    super(scope, id);
    if (props.subnets.length !== DEV_EKS_MSK.brokerCount) {
      throw new Error(`MSK broker ${DEV_EKS_MSK.brokerCount}대에는 서로 다른 AZ의 subnet ${DEV_EKS_MSK.brokerCount}개가 필요하다`);
    }
    this.topicName = devTelemetryTopicName(props.stage);
    this.consumerGroupName = devTelemetryConsumerGroupName(props.stage);

    this.logGroup = new LogGroup(this, 'BrokerLogs', {
      logGroupName: DEV_EKS_MSK.logGroupName,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.configuration = new CfnConfiguration(this, 'Configuration', {
      name: DEV_EKS_MSK.configurationName,
      description: 'dev telemetry ingress broker settings',
      kafkaVersionsList: [DEV_EKS_MSK.kafkaVersion],
      serverProperties: Object.entries(DEV_EKS_MSK_SERVER_PROPERTIES).map(([key, value]) => `${key}=${value}`).join('\n'),
    });
    this.cluster = new CfnCluster(this, 'Cluster', {
      clusterName: DEV_EKS_MSK.clusterName,
      kafkaVersion: DEV_EKS_MSK.kafkaVersion,
      numberOfBrokerNodes: DEV_EKS_MSK.brokerCount,
      brokerNodeGroupInfo: {
        instanceType: DEV_EKS_MSK.instanceType,
        clientSubnets: props.subnets.map(subnet => subnet.subnetId),
        securityGroups: [props.securityGroup.securityGroupId],
        storageInfo: { ebsStorageInfo: { volumeSize: DEV_EKS_MSK.volumeSizeGiB } },
        connectivityInfo: { publicAccess: { type: 'DISABLED' } },
      },
      // IAM만 허용한다. 평문·SCRAM·TLS 인증서 인증 listener를 열지 않는다.
      clientAuthentication: {
        sasl: { iam: { enabled: true }, scram: { enabled: false } },
        unauthenticated: { enabled: false },
      },
      // 저장 암호화는 KMS key를 지정하지 않아 AWS 관리 키를 사용한다.
      encryptionInfo: { encryptionInTransit: { clientBroker: 'TLS', inCluster: true } },
      configurationInfo: { arn: this.configuration.attrArn, revision: this.configuration.attrLatestRevisionRevision },
      enhancedMonitoring: 'DEFAULT',
      openMonitoring: { prometheus: { jmxExporter: { enabledInBroker: true }, nodeExporter: { enabledInBroker: true } } },
      loggingInfo: { brokerLogs: { cloudWatchLogs: { enabled: true, logGroup: this.logGroup.logGroupName } } },
    });

    const stack = Stack.of(this);
    const uuid = Fn.select(2, Fn.split('/', this.cluster.attrArn));
    const dataArn = (resource: 'topic' | 'group', name: string) => stack.formatArn({
      service: 'kafka', resource, resourceName: `${DEV_EKS_MSK.clusterName}/${uuid}/${name}`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.topicArn = dataArn('topic', this.topicName);
    this.consumerGroupArn = dataArn('group', this.consumerGroupName);

    for (const [name, value] of Object.entries({
      MskClusterArn: this.cluster.attrArn,
      MskClusterName: DEV_EKS_MSK.clusterName,
      MskStage: props.stage,
      MskTopicName: this.topicName,
      MskConsumerGroupName: this.consumerGroupName,
      MskBrokerLogGroupName: this.logGroup.logGroupName,
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }
}
