import { CfnOutput } from 'aws-cdk-lib/core';
import { CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { ArnPrincipal, IRole, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ILogGroup } from 'aws-cdk-lib/aws-logs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import {
  PERF_ARCHIVE_PREFIX, PERF_ENVIRONMENT_EVIDENCE_PREFIX, PERF_EVIDENCE_PREFIX, PERF_MSK_SESSION_NAMES, PERF_NAMESPACES,
  PERF_SERVICE_ACCOUNTS,
} from './config';

export interface PerfEksAccessProps {
  readonly clusterName: string;
  readonly operatorRole: IRole;
  readonly secrets: {
    readonly db: ISecret; readonly tokenHash: ISecret; readonly adminApiToken: ISecret;
    readonly telemetryJwtPrivateKey: ISecret; readonly telemetryJwtPublicKeys: ISecret;
    readonly syntheticSeed: ISecret; readonly seedDb: ISecret; readonly verifyDb: ISecret; readonly grafanaAdmin: ISecret;
  };
  readonly rawSignalBucket: IBucket;
  readonly evidenceBucket: IBucket;
  readonly msk?: { readonly clusterArn: string; readonly topicArn: string; readonly consumerGroupArn: string };
  readonly logGroups: {
    readonly application: ILogGroup; readonly observability: ILogGroup; readonly events: ILogGroup;
    readonly broker?: ILogGroup; readonly controlPlane: ILogGroup;
  };
}

/**
 * workload·Job별 Pod Identity 역할. 역할 하나가 namespace·ServiceAccount 하나만 받는다.
 *
 * - runner는 evidence `runs/*` PutObject만 갖는다. MSK·DB·JWT 개인키 권한이 없다(perf-jobs.md §2).
 * - prepare는 JWT 공개키만 받는다. 개인키는 enrollment만 읽는다.
 * - smoke(readiness)는 Gateway로 golden을 보내고 CH·archive 표본을 대조한 뒤 증거만 올린다.
 * - evidence 쓰기는 조건부 PUT(`If-None-Match`)만 허용해 기존 증거를 덮지 않는다.
 */
export class PerfEksAccess extends Construct {
  public readonly roles: Readonly<Record<keyof typeof PERF_SERVICE_ACCOUNTS, Role>>;
  public readonly mskRoles?: Readonly<Record<keyof typeof PERF_MSK_SESSION_NAMES, Role>>;

  constructor(scope: Construct, id: string, props: PerfEksAccessProps) {
    super(scope, id);
    const accounts = PERF_SERVICE_ACCOUNTS;
    const ns = PERF_NAMESPACES;
    const role = (key: keyof typeof accounts, namespace: string) => this.podRole(key, props.clusterName, namespace, accounts[key]);
    this.roles = {
      enrollment: role('enrollment', ns.app), ingest: role('ingest', ns.app), gateway: role('gateway', ns.app),
      topicAdmin: role('topicAdmin', ns.app), offsetAdmin: role('offsetAdmin', ns.app),
      seed: role('seed', ns.runner), prepare: role('prepare', ns.runner), smoke: role('smoke', ns.runner), sentinel: role('sentinel', ns.runner),
      runner: role('runner', ns.runner), verify: role('verify', ns.runner),
      fluentBit: role('fluentBit', ns.logs), grafana: role('grafana', ns.observability), events: role('events', ns.observability),
    };
    const r = this.roles;
    const s = props.secrets;
    grantSecretRead(r.enrollment, [s.db, s.tokenHash, s.adminApiToken, s.telemetryJwtPrivateKey, s.telemetryJwtPublicKeys]);
    grantSecretRead(r.ingest, [s.db, s.tokenHash, s.telemetryJwtPublicKeys]);
    grantSecretRead(r.gateway, [s.telemetryJwtPublicKeys]);
    grantSecretRead(r.seed, [s.seedDb, s.syntheticSeed]);
    grantSecretRead(r.prepare, [s.verifyDb, s.syntheticSeed, s.telemetryJwtPublicKeys]);
    grantSecretRead(r.grafana, [s.grafanaAdmin]);

    // grantWrite()는 multipart·삭제까지 넓히므로 PutObject만 선언한다.
    r.ingest.addToPolicy(new PolicyStatement({
      actions: ['s3:PutObject'], resources: [props.rawSignalBucket.arnForObjects(`${PERF_ARCHIVE_PREFIX}/*`)],
      conditions: { Bool: { 'aws:SecureTransport': 'true' } },
    }));
    const runs = props.evidenceBucket.arnForObjects(`${PERF_EVIDENCE_PREFIX}*`);
    for (const writer of [r.seed, r.prepare, r.smoke, r.sentinel, r.runner, r.verify]) grantEvidenceCreate(writer, [runs]);
    // verify는 journal을, prepare는 회전 경계 확인용 이전 run journal(PREVIOUS_EVIDENCE_URI)을 읽는다.
    for (const reader of [r.prepare, r.verify]) reader.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'], resources: [runs], conditions: { Bool: { 'aws:SecureTransport': 'true' } },
    }));
    r.verify.addToPolicy(new PolicyStatement({
      actions: ['s3:ListBucket'], resources: [props.evidenceBucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${PERF_EVIDENCE_PREFIX}*`] }, Bool: { 'aws:SecureTransport': 'true' } },
    }));
    // verify와 readiness smoke는 archive pointer 표본만 GET한다. 쓰기·목록은 없다.
    for (const reader of [r.verify, r.smoke]) reader.addToPolicy(new PolicyStatement({
      actions: ['s3:GetObject'], resources: [props.rawSignalBucket.arnForObjects(`${PERF_ARCHIVE_PREFIX}/*`)],
      conditions: { Bool: { 'aws:SecureTransport': 'true' } },
    }));
    // drain 판정의 Kafka lag(AWS/Kafka SumOffsetLag)을 읽는다. 이 API는 리소스 수준 권한이 없고 문서상
    // cloudwatch:namespace 조건은 PutMetricData 전용이라 리전 조건만 건다.
    if (props.msk) r.verify.addToPolicy(new PolicyStatement({
      actions: ['cloudwatch:GetMetricStatistics'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } },
    }));
    // 운영자는 smoke·환경 증거를 쓰고 run 증거를 읽는다. 삭제 권한은 주지 않는다.
    const environments = props.evidenceBucket.arnForObjects(`${PERF_ENVIRONMENT_EVIDENCE_PREFIX}*`);
    grantEvidenceCreate(props.operatorRole, [runs, environments]);
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['s3:GetObject', 's3:GetObjectVersion'], resources: [runs, environments],
    }));
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['s3:ListBucket', 's3:ListBucketVersions'], resources: [props.evidenceBucket.bucketArn],
    }));

    // MSK 데이터 권한은 workload별 MSK 전용 역할에 있다. 대응 Pod 역할만 고정 세션 이름으로 assume한다(ADR-0036).
    const sessions = PERF_MSK_SESSION_NAMES;
    if (props.msk) {
    const { clusterArn, topicArn, consumerGroupArn } = props.msk;
    const kafka = (resource: string, ...actions: string[]) => new PolicyStatement({
      actions: actions.map(action => `kafka-cluster:${action}`), resources: [resource],
    });
    this.mskRoles = {
      gateway: this.mskRole('Gateway', r.gateway, sessions.gateway, [
        kafka(clusterArn, 'Connect', 'WriteDataIdempotently'), kafka(topicArn, 'DescribeTopic', 'WriteData'),
      ]),
      ingest: this.mskRole('Ingest', r.ingest, sessions.ingest, [
        kafka(clusterArn, 'Connect'), kafka(topicArn, 'DescribeTopic', 'ReadData'), kafka(consumerGroupArn, 'DescribeGroup', 'AlterGroup'),
      ]),
      topicAdmin: this.mskRole('TopicAdmin', r.topicAdmin, sessions.topicAdmin, [
        kafka(clusterArn, 'Connect'),
        kafka(topicArn, 'CreateTopic', 'DescribeTopic', 'DescribeTopicDynamicConfiguration', 'AlterTopicDynamicConfiguration'),
      ]),
      offsetAdmin: this.mskRole('OffsetAdmin', r.offsetAdmin, sessions.offsetAdmin, [
        kafka(clusterArn, 'Connect'), kafka(consumerGroupArn, 'DescribeGroup', 'AlterGroup'), kafka(topicArn, 'DescribeTopic', 'ReadData'),
      ]),
    };

    }
    const writeLogs = (writer: Role, groups: ILogGroup[]) => writer.addToPolicy(new PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'], resources: groups.map(group => group.logGroupArn),
    }));
    writeLogs(r.fluentBit, [props.logGroups.application, props.logGroups.observability]);
    writeLogs(r.events, [props.logGroups.events]);
    r.grafana.addToPolicy(new PolicyStatement({
      actions: ['cloudwatch:ListMetrics', 'cloudwatch:GetMetricData'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } },
    }));
    const groups = Object.values(props.logGroups).filter((group): group is ILogGroup => group !== undefined);
    r.grafana.addToPolicy(new PolicyStatement({
      actions: ['logs:StartQuery', 'logs:GetLogGroupFields', 'logs:GetLogEvents', 'logs:DescribeLogStreams'],
      resources: groups.map(group => group.logGroupArn),
    }));
    // 이 API는 log-group ARN 수준의 리소스 제한을 지원하지 않는다.
    r.grafana.addToPolicy(new PolicyStatement({
      actions: ['logs:DescribeLogGroups', 'logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': 'ap-northeast-2' } },
    }));

    for (const [name, value] of Object.entries({
      EnrollmentRoleArn: r.enrollment.roleArn, TelemetryIngestRoleArn: r.ingest.roleArn, TelemetryGatewayRoleArn: r.gateway.roleArn,
      SeedRoleArn: r.seed.roleArn, PrepareRoleArn: r.prepare.roleArn, SmokeRoleArn: r.smoke.roleArn, SentinelRoleArn: r.sentinel.roleArn,
      RunnerRoleArn: r.runner.roleArn, VerifierRoleArn: r.verify.roleArn, VerifierRoleName: r.verify.roleName,
      GrafanaRoleArn: r.grafana.roleArn, FluentBitRoleArn: r.fluentBit.roleArn, KubernetesEventsRoleArn: r.events.roleArn,
      ...(this.mskRoles ? { MskGatewayRoleArn: this.mskRoles.gateway.roleArn, MskIngestRoleArn: this.mskRoles.ingest.roleArn,
      MskTopicAdminRoleArn: this.mskRoles.topicAdmin.roleArn, MskOffsetAdminRoleArn: this.mskRoles.offsetAdmin.roleArn,
      MskGatewaySessionName: sessions.gateway, MskIngestSessionName: sessions.ingest,
      MskTopicAdminSessionName: sessions.topicAdmin, MskOffsetAdminSessionName: sessions.offsetAdmin, } : {}),
    })) new CfnOutput(this, name, { value }).overrideLogicalId(name);
  }

  private podRole(key: string, clusterName: string, namespace: string, serviceAccount: string): Role {
    const id = key.charAt(0).toUpperCase() + key.slice(1);
    const role = new Role(this, `${id}Role`, {
      description: `perf EKS Pod Identity for ${namespace}/${serviceAccount}`,
      assumedBy: new ServicePrincipal('pods.eks.amazonaws.com').withSessionTags().withConditions({ StringEquals: {
        'aws:RequestTag/eks-cluster-name': clusterName,
        'aws:RequestTag/kubernetes-namespace': namespace,
        'aws:RequestTag/kubernetes-service-account': serviceAccount,
      } }),
    });
    new CfnPodIdentityAssociation(this, `${id}Association`, {
      clusterName, namespace, serviceAccount, roleArn: role.roleArn, disableSessionTags: false,
    });
    return role;
  }

  /** Pod Identity 자격 갱신으로 세션 이름이 바뀌어도 MSK 재인증 주체가 같도록 고정 세션 이름을 쓴다(ADR-0036). */
  private mskRole(id: string, podRole: Role, sessionName: string, statements: PolicyStatement[]): Role {
    const principal = new ArnPrincipal(podRole.roleArn);
    const role = new Role(this, `${id}MskRole`, {
      description: `perf MSK data access for ${sessionName}`,
      assumedBy: principal.withConditions({ StringEquals: { 'sts:RoleSessionName': sessionName } }),
    });
    role.assumeRolePolicy!.addStatements(new PolicyStatement({ actions: ['sts:TagSession'], principals: [principal] }));
    for (const statement of statements) role.addToPolicy(statement);
    podRole.addToPolicy(new PolicyStatement({ actions: ['sts:AssumeRole', 'sts:TagSession'], resources: [role.roleArn] }));
    return role;
  }
}

function grantSecretRead(role: Role, secrets: ISecret[]): void {
  role.addToPolicy(new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    resources: secrets.map(secret => secret.secretArn),
    conditions: { Bool: { 'aws:SecureTransport': 'true' } },
  }));
}

/** 증거는 새 key로만 만든다. `If-None-Match` 헤더가 없는 PUT은 허용하지 않는다. */
function grantEvidenceCreate(role: IRole, resources: string[]): void {
  role.addToPrincipalPolicy(new PolicyStatement({
    actions: ['s3:PutObject'], resources,
    conditions: { Null: { 's3:if-none-match': 'false' }, Bool: { 'aws:SecureTransport': 'true' } },
  }));
}
