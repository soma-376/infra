import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ILogGroup, LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export const DEV_OBSERVABILITY_NAMESPACE = 'pulsemetry-observability';

/** AWS 참조와 권한만 소유한다. 설치·dashboard·Events collector는 Helm이 소유한다. (ADR-0037) */
export class DevEksObservability extends Construct {
  constructor(scope: Construct, id: string, props: {
    clusterName: string; applicationLogGroup: ILogGroup; brokerLogGroup: ILogGroup;
    fluentBitRole: Role; operatorRole: Role;
  }) {
    super(scope, id);
    const stack = Stack.of(this);
    const logs = new LogGroup(this, 'Logs', {
      logGroupName: '/eks/dev/observability', retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const events = new LogGroup(this, 'Events', {
      logGroupName: '/eks/dev/events', retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const admin = new Secret(this, 'GrafanaAdmin', {
      secretName: 'soma-376/dev/observability/grafana-admin',
      description: 'dev Grafana admin password, supplied through CSI only',
      generateSecretString: { secretStringTemplate: '{}', generateStringKey: 'password', passwordLength: 40, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const role = (name: string, serviceAccount: string) => {
      const result = new Role(this, name, {
        assumedBy: new ServicePrincipal('pods.eks.amazonaws.com').withSessionTags().withConditions({ StringEquals: {
          'aws:RequestTag/eks-cluster-name': props.clusterName,
          'aws:RequestTag/kubernetes-namespace': DEV_OBSERVABILITY_NAMESPACE,
          'aws:RequestTag/kubernetes-service-account': serviceAccount,
        } }),
      });
      new CfnPodIdentityAssociation(this, `${name}Association`, {
        clusterName: props.clusterName, namespace: DEV_OBSERVABILITY_NAMESPACE, serviceAccount,
        roleArn: result.roleArn, disableSessionTags: false,
      });
      return result;
    };
    const grafana = role('Grafana', 'grafana');
    admin.grantRead(grafana);
    // 경보 조회 패널이 없으므로 DescribeAlarms·DescribeAlarmHistory는 주지 않는다.
    grafana.addToPolicy(new PolicyStatement({
      actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'],
      resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
    }));
    // log-group ARN은 `log-group:<이름>` 형식이다. 기본 `/` 구분자는 `log-group//aws/...`를 만들어 조회가 거부된다.
    const controlPlaneArn = stack.formatArn({
      service: 'logs', resource: 'log-group', resourceName: `/aws/eks/${props.clusterName}/cluster:*`,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
    grafana.addToPolicy(new PolicyStatement({
      actions: ['logs:StartQuery', 'logs:GetLogGroupFields', 'logs:GetLogEvents', 'logs:DescribeLogStreams'],
      resources: [props.applicationLogGroup.logGroupArn, props.brokerLogGroup.logGroupArn, logs.logGroupArn, events.logGroupArn, controlPlaneArn],
    }));
    // 이 API는 log-group ARN 수준의 리소스 제한을 지원하지 않는다.
    grafana.addToPolicy(new PolicyStatement({
      actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': stack.region } },
    }));
    const eventRole = role('EventsCollector', 'kubernetes-events');
    const writeLogs = (writer: Role, group: ILogGroup) => writer.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'], resources: [group.logGroupArn],
    }));
    writeLogs(eventRole, events);
    writeLogs(props.fluentBitRole, logs);
    const diagnostics = new Bucket(this, 'Diagnostics', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL, encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true, lifecycleRules: [{ expiration: Duration.days(14), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      removalPolicy: RemovalPolicy.RETAIN,
    });
    props.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject', 's3:GetObject'], resources: [diagnostics.arnForObjects('nodes/*')],
    }));
    for (const [key, value] of Object.entries({
      ObservabilityNamespace: DEV_OBSERVABILITY_NAMESPACE,
      GrafanaAdminSecretArn: admin.secretArn, GrafanaRoleArn: grafana.roleArn,
      KubernetesEventsRoleArn: eventRole.roleArn, KubernetesEventsLogGroupName: events.logGroupName,
      ObservabilityLogGroupName: logs.logGroupName, DiagnosticsBucketName: diagnostics.bucketName,
      EksControlPlaneLogGroupName: `/aws/eks/${props.clusterName}/cluster`,
    })) new CfnOutput(this, key, { value }).overrideLogicalId(key);
  }
}
