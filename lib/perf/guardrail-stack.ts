import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib/core';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { CfnDocument, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { PERF_ECR_REPOSITORIES, LoadedPerfBudget } from './budget';
import { PERF_ENVIRONMENT_TAG, PERF_EKS_CLUSTER_NAME } from './config';

export const PERF_CLEANUP_DOCUMENT = 'soma-376-perf-cleanup';
export const PERF_CLEANUP_FUNCTION = 'soma-376-perf-cleanup';
export const perfCleanupState = (environmentId: string) => `/soma-376/perf/${environmentId}/cleanup-state`;

/** workload/VPC의 CFN 참조가 없다. 먼저 만들고 모든 외부 소유 자원이 사라진 뒤 자체 삭제한다. */
export class PerfGuardrailStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { environmentId: string; budget: LoadedPerfBudget }) {
    super(scope, id, props);
    const owner = props.environmentId;
    const stateName = perfCleanupState(owner);
    const state = new StringParameter(this, 'State', { parameterName: stateName,
      stringValue: JSON.stringify({ version: 1, environment_id: owner, phase: 'WAITING', buckets: [], attempts: 0 }) });
    const document = new CfnDocument(this, 'KubernetesCleanup', { name: PERF_CLEANUP_DOCUMENT, documentType: 'Command', documentFormat: 'JSON', updateMethod: 'NewVersion',
      content: { schemaVersion: '2.2', description: 'Owned perf cluster cleanup only; no arbitrary command inputs',
        parameters: { nodeRoleName: { type: 'String', description: 'Actual owned PerfEksStack NodeRole output', allowedPattern: '^PerfEksStack-NodeRole[A-Za-z0-9-]+$' } },
        mainSteps: [{ action: 'aws:runShellScript', name: 'cleanup', inputs: { timeoutSeconds: '90', runCommand: [
          `export PERF_CLEANUP_ENVIRONMENT_ID='${owner}'`,
          "export PERF_CLEANUP_NODE_ROLE='{{ nodeRoleName }}'",
          `python3 - <<'PERF_CLEANUP_PY'\n${readFileSync(join(__dirname, 'cleanup/kubernetes.py'), 'utf8')}\nPERF_CLEANUP_PY`,
        ] } }] } });
    const logs = new LogGroup(this, 'Logs', { logGroupName: `/aws/lambda/${PERF_CLEANUP_FUNCTION}`, retention: RetentionDays.ONE_DAY, removalPolicy: RemovalPolicy.DESTROY });
    const role = new Role(this, 'CleanupRole', { assumedBy: new ServicePrincipal('lambda.amazonaws.com') });
    logs.grantWrite(role);
    const handler = new Function(this, 'Cleanup', { functionName: PERF_CLEANUP_FUNCTION, runtime: Runtime.PYTHON_3_13, architecture: Architecture.ARM_64,
      code: Code.fromAsset(join(__dirname, 'cleanup'), { exclude: ['__pycache__', '*.pyc'] }), handler: 'driver.handler', memorySize: 256, timeout: Duration.seconds(55), reservedConcurrentExecutions: 1,
      role, logGroup: logs, environment: { CLEANUP_CONFIG: JSON.stringify({ environment_id: owner, account: this.account, region: this.region, state_parameter: stateName, document_name: PERF_CLEANUP_DOCUMENT }) } });
    state.grantRead(handler); state.grantWrite(handler);
    const arn = (service: string, resource: string) => `arn:${this.partition}:${service}:${this.region}:${this.account}:${resource}`;
    const cfns = ['PerfGuardrailStack', 'PerfEdgeStack', 'PerfEksStack', 'PerfDataStack', 'PerfNetworkStack', 'PerfEvidenceStack'].map(name => arn('cloudformation', `stack/${name}/*`));
    const add = (actions: string[], resources: string[], conditions?: Record<string, any>) => handler.addToRolePolicy(new PolicyStatement({ actions, resources, conditions }));
    add(['cloudformation:DescribeStacks', 'cloudformation:ListStackResources'], cfns);
    add(['cloudformation:DeleteStack'], cfns, { StringEquals: { [`aws:ResourceTag/${PERF_ENVIRONMENT_TAG}`]: owner } });
    const repos = PERF_ECR_REPOSITORIES.map(name => arn('ecr', `repository/${name}`));
    add(['ecr:DescribeRepositories', 'ecr:ListTagsForResource'], repos);
    add(['ecr:DeleteRepository'], repos, { StringEquals: { [`aws:ResourceTag/${PERF_ENVIRONMENT_TAG}`]: owner } });
    add(['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeLaunchTemplates'], ['*'], { StringEquals: { 'aws:RequestedRegion': this.region } });
    add(['ec2:TerminateInstances', 'ec2:DeleteVolume'], [arn('ec2', 'instance/*'), arn('ec2', 'volume/*')], { StringEquals: { [`ec2:ResourceTag/${PERF_ENVIRONMENT_TAG}`]: owner } });
    // IAM은 global service다. EKS 참조 없이 실제 output의 고정 역할 prefix로 제한한다.
    add(['iam:ListInstanceProfilesForRole'], [`arn:${this.partition}:iam::${this.account}:role/PerfEksStack-NodeRole*`]);
    add(['eks:DescribeCluster'], [arn('eks', `cluster/${PERF_EKS_CLUSTER_NAME}`)]);
    add(['ssm:SendCommand'], [arn('ssm', `document/${PERF_CLEANUP_DOCUMENT}`)]);
    add(['ssm:SendCommand'], [arn('ec2', 'instance/*')], { StringEquals: { [`ssm:resourceTag/${PERF_ENVIRONMENT_TAG}`]: owner } });
    add(['ssm:GetCommandInvocation'], ['*'], { StringEquals: { 'aws:RequestedRegion': this.region } });
    // 자동 이름은 네 고정 perf 스택 prefix 안으로 제한하고 매 API 실행 전 GetBucketTagging으로 소유권을 확인한다.
    const buckets = ['perfdatastack', 'perfeksstack', 'perfevidencestack', 'perfedgestack'].map(name => `arn:${this.partition}:s3:::${name}-*`);
    add(['s3:GetBucketTagging', 's3:ListBucketVersions', 's3:ListBucketMultipartUploads', 's3:DeleteBucket'], buckets);
    add(['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:AbortMultipartUpload'], buckets.map(name => `${name}/*`));
    const schedule = new Rule(this, 'Schedule', { schedule: Schedule.rate(Duration.minutes(1)) });
    schedule.addTarget(new LambdaFunction(handler, { retryAttempts: 0, maxEventAge: Duration.minutes(1) }));
    handler.node.addDependency(document);
    for (const [name, value] of Object.entries({ PerfCleanupFunctionName: handler.functionName, PerfCleanupStateParameter: state.parameterName,
      PerfBudgetSha256: props.budget.sha256, PerfBudgetEstimateKrw: String(props.budget.policy.estimated_total), PerfBudgetLimitKrw: '100000', PerfCleanupStartSeconds: '79200', PerfDeadlineSeconds: '86400', PerfEvidenceCleanupMode: 'owned-24h', PerfNewEcrRepositories: PERF_ECR_REPOSITORIES.join(',') })) {
      new CfnOutput(this, name, { value }).overrideLogicalId(name);
    }
  }
}
