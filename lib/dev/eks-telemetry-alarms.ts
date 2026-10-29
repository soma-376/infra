import { Duration } from 'aws-cdk-lib/core';
import {
  Alarm, ComparisonOperator, IMetric, MathExpression, Metric, TreatMissingData,
} from 'aws-cdk-lib/aws-cloudwatch';
import { FilterPattern, ILogGroup, MetricFilter } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { DEV_EKS_MSK } from './eks-config';

/**
 * backend가 평문 `event=<code>` 한 줄로 남기는 실패 이벤트다. Fluent Bit envelope의 `log`에 원문이 그대로 있다.
 * 실제 filter engine 일치는 배포 전 `scripts/observability-metric-filter-check.mjs --aws`로 확인한다. (ADR-0035·0037)
 */
export const DEV_TELEMETRY_LOG_EVENTS = {
  telemetry_gateway_rejected: { metricName: 'TelemetryGatewayRejected', threshold: 50 },
  telemetry_publish_failed: { metricName: 'TelemetryPublishFailed', threshold: 1 },
  telemetry_permanent_failure: { metricName: 'TelemetryPermanentFailure', threshold: 1 },
  telemetry_retry_exhausted: { metricName: 'TelemetryRetryExhausted', threshold: 1 },
  telemetry_commit_failed: { metricName: 'TelemetryCommitFailed', threshold: 1 },
} as const;

export const DEV_TELEMETRY_METRIC_NAMESPACE = 'Pulsemetry/Dev/Telemetry';

export interface DevEksTelemetryAlarmsProps {
  readonly topicName: string;
  readonly consumerGroupName: string;
  readonly applicationLogGroup: ILogGroup;
  readonly mskMetricsEnabled?: boolean;
}

/**
 * MSK 공간·복제·consumer lag과 앱 로그 이벤트 경보. SNS가 없어 상태만 남는다.
 * 임계값은 실측 전 dev 초기 가설이다. Pod 재시작·OOM은 Container Insights가 없어 범위 밖이다. (ADR-0035)
 */
export class DevEksTelemetryAlarms extends Construct {
  public readonly alarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: DevEksTelemetryAlarmsProps) {
    super(scope, id);
    if (props.mskMetricsEnabled !== false) {
      const cluster = { 'Cluster Name': DEV_EKS_MSK.clusterName };
      const kafka = (metricName: string, dimensions: Record<string, string>, statistic: string, period: Duration) => new Metric({
        namespace: 'AWS/Kafka', metricName, dimensionsMap: dimensions, statistic, period,
      });
      const brokers = (metricName: string, statistic: string, period: Duration) => Object.fromEntries(
        Array.from({ length: DEV_EKS_MSK.brokerCount }, (_, index) => [
          `b${index + 1}`, kafka(metricName, { ...cluster, 'Broker ID': String(index + 1) }, statistic, period),
        ]));
      const minute = Duration.minutes(1), fiveMinutes = Duration.minutes(5);
      const group = { ...cluster, 'Consumer Group': props.consumerGroupName, Topic: props.topicName };

      // broker별 지표를 하나의 경보로 모은다. broker ID는 MSK가 1부터 부여한다.
      this.add('MskDiskUsed', 'Highest MSK broker data log disk usage is at or above 80 percent', 'msk-disk-used',
        new MathExpression({ expression: 'MAX([b1, b2, b3])', usingMetrics: brokers('KafkaDataLogsDiskUsed', 'Maximum', fiveMinutes), period: fiveMinutes, label: 'MaxKafkaDataLogsDiskUsed' }),
        80, 2, 2, TreatMissingData.MISSING);
      this.add('MskUnderMinIsr', 'MSK partitions are below min.insync.replicas and reject acks=all writes', 'msk-under-min-isr',
        new MathExpression({ expression: 'SUM([b1, b2, b3])', usingMetrics: brokers('UnderMinIsrPartitionCount', 'Maximum', minute), period: minute, label: 'UnderMinIsrPartitionCount' }),
        1, 5, 3, TreatMissingData.MISSING);
      this.add('MskOfflinePartitions', 'MSK has offline partitions', 'msk-offline-partitions',
        kafka('OfflinePartitionsCount', cluster, 'Maximum', minute), 1, 5, 3, TreatMissingData.MISSING);
      // group이 offset을 commit하기 전에는 lag 지표가 없다.
      this.add('ConsumerTimeLag', 'Telemetry ingest consumer is more than 10 minutes behind', 'consumer-time-lag',
        kafka('EstimatedMaxTimeLag', group, 'Maximum', fiveMinutes), 600, 3, 3, TreatMissingData.NOT_BREACHING);
      this.add('ConsumerOffsetLag', 'Telemetry ingest consumer backlog exceeds 10000 records', 'consumer-offset-lag',
        kafka('SumOffsetLag', group, 'Maximum', fiveMinutes), 10_000, 3, 3, TreatMissingData.NOT_BREACHING);
    }

    const fiveMinutes = Duration.minutes(5);
    for (const [event, { metricName, threshold }] of Object.entries(DEV_TELEMETRY_LOG_EVENTS)) {
      const filter = new MetricFilter(this, `${metricName}Filter`, {
        logGroup: props.applicationLogGroup,
        // 따옴표 term은 envelope 안 원문의 key=value 부분 문자열과 일치해야 한다.
        filterPattern: FilterPattern.literal(`"event=${event}"`),
        metricNamespace: DEV_TELEMETRY_METRIC_NAMESPACE, metricName, metricValue: '1',
      });
      this.add(metricName, `Count of event=${event} log lines in the dev EKS application log group`,
        event.replace(/^telemetry_/, '').replaceAll('_', '-'),
        filter.metric({ statistic: 'Sum', period: fiveMinutes }), threshold, 1, 1, TreatMissingData.NOT_BREACHING);
    }
  }

  private add(id: string, description: string, name: string, metric: IMetric, threshold: number,
    evaluationPeriods: number, datapointsToAlarm: number, treatMissingData: TreatMissingData): void {
    // 알림 action은 없다. 경보 상태 조회는 런북 절차를 따른다.
    this.alarms.push(new Alarm(this, id, {
      alarmName: `soma-376-dev-telemetry-${name}`,
      alarmDescription: description, metric, threshold, evaluationPeriods, datapointsToAlarm, treatMissingData,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    }));
  }
}
