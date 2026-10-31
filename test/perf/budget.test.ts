import { resolve } from 'node:path';
import { Template } from 'aws-cdk-lib/assertions';
import { buildPerfApp } from '../helpers';
import { checkPerfExecution, loadPerfBudget, PerfExecutionObservation } from '../../lib/perf/budget';
import { loadPerfProfile } from '../../lib/perf/profile';
import { collectPerfOutputs } from '../../lib/perf/deploy-inputs';
import { cleanupInventory } from '../../lib/perf/results';
import { residualReport } from '../../lib/perf/inventory';
import { describeStacks, ENVIRONMENT_ID } from './perf-fixtures';

const root = resolve(__dirname, '../..');
const profile = loadPerfProfile('profiles/perf/strimzi-fixed-v1.json', root);
const budget = loadPerfBudget(root, profile, 1);
const now = Date.parse('2026-11-01T01:00:00Z');
const observation = (): PerfExecutionObservation => ({ environment_id: ENVIRONMENT_ID, policy_sha256: budget.sha256, source_sha256: 'a'.repeat(64), observed_at: '2026-11-01T01:00:00Z', resource_created_at: ['2026-11-01T00:00:00Z'], requests_consumed: 5, requests_reserved: 5, planned_requests: 4000, planned_rps: 20, planned_run_seconds: 200, added_storage_bytes: 0, planned_added_storage_bytes: 500000,
  disks: ['clickhouse', 'kafka', 'kafka', 'kafka', 'generator'].map((role, i) => ({ role: role as any, identity: `disk-${i}`, total_bytes: 100 * 1024 ** 3, free_bytes: 40 * 1024 ** 3 })) });

test('pin한 profile/NAT와 예산을 지키고 새 profile 또는 NAT 확대를 거부한다', () => {
  expect(budget.policy).toMatchObject({ budget_total: 100000, estimated_total: 97586, actual_billing_verified: false });
  expect(() => loadPerfBudget(root, { ...profile, sha256: '0'.repeat(64) }, 1)).toThrow(/profile/);
  expect(() => loadPerfBudget(root, profile, 2)).toThrow(/NAT/);
  expect(() => checkPerfExecution(budget, ENVIRONMENT_ID, observation(), now)).not.toThrow();
});

test.each([
  ['누적 요청', (o: any) => { o.requests_consumed = 6000; }],
  ['RPS', (o: any) => { o.planned_rps = 21; }],
  ['600초', (o: any) => { o.planned_run_seconds = 601; }],
  ['추가 저장', (o: any) => { o.added_storage_bytes = 1024 ** 3; }],
  ['관측 freshness', (o: any) => { o.observed_at = '2026-11-01T00:58:59Z'; }],
  ['미래 관측', (o: any) => { o.observed_at = '2026-11-02T00:00:00Z'; }],
  ['deadline', (o: any) => { o.resource_created_at = ['2026-10-31T03:30:00Z']; }],
  ['생성 근거 누락', (o: any) => { o.resource_created_at = []; }],
  ['policy 불일치', (o: any) => { o.policy_sha256 = 'b'.repeat(64); }],
  ['20% 하한', (o: any) => { o.disks[0].total_bytes = 300 * 1024 ** 3; }],
  ['Kafka 누락', (o: any) => { o.disks.splice(1, 1); }],
  ['발생기 10GiB', (o: any) => { o.disks[4].free_bytes = 9 * 1024 ** 3; }],
  ['음수', (o: any) => { o.requests_consumed = -1; }],
])('%s 초과/누락이면 실행하지 않는다', (_, mutate) => {
  const o = observation(); mutate(o); expect(() => checkPerfExecution(budget, ENVIRONMENT_ID, o, now)).toThrow();
});

test('guard는 VPC 밖에서 먼저 생성하고 exact perf 삭제 허용목록/owner 조건을 쓴다', () => {
  const built = buildPerfApp({ perfProfile: profile.path });
  const guard = Template.fromStack(built.guardrail!);
  guard.resourceCountIs('AWS::Lambda::Function', 1);
  expect(JSON.stringify(Template.fromStack(built.eks).findResources('AWS::EC2::Instance'))).toContain('dnf install -y python3 awscli-2');
  guard.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: 'rate(1 minute)' });
  guard.hasResourceProperties('AWS::Lambda::Function', { ReservedConcurrentExecutions: 1, Timeout: 55, MemorySize: 256 });
  for (const stack of [built.network, built.evidence, built.data, built.eks]) {
    const template = Template.fromStack(stack);
    for (const fn of Object.values(template.findResources('AWS::Lambda::Function'))) expect(fn.Properties.LoggingConfig).toBeDefined();
    expect(Object.values(template.toJSON().Resources).some((r: any) => ['Retain', 'Snapshot'].includes(r.DeletionPolicy))).toBe(false);
  }
  const fn: any = Object.values(guard.findResources('AWS::Lambda::Function'))[0];
  expect(fn.Properties.VpcConfig).toBeUndefined();
  const statements = Object.values(guard.findResources('AWS::IAM::Policy')).flatMap((value: any) => value.Properties.PolicyDocument.Statement);
  const remove = statements.filter((s: any) => JSON.stringify(s.Action).includes('DeleteRepository'));
  expect(remove).toHaveLength(1);
  expect(JSON.stringify(remove)).toContain('repository/soma-376/perf-k6-runner');
  expect(remove[0].Condition.StringEquals['aws:ResourceTag/pulsemetry:perf-environment']).toBe(ENVIRONMENT_ID);
  expect(JSON.stringify(statements)).not.toMatch(/acm:|iam:PassRole|soma-376-dev/);
  for (const stack of built.app.synth().stacks.filter(s => s.stackName !== 'PerfGuardrailStack')) expect(stack.dependencies.some(d => d.id === 'PerfGuardrailStack')).toBe(true);
  expect(built.app.synth().getStackArtifact('PerfGuardrailStack').dependencies.filter(d => !d.id.endsWith('.assets'))).toHaveLength(0);
});

test('Strimzi evidence/ALB 로그는 Destroy이고 기존 MSK evidence는 Retain이다', () => {
  const built = buildPerfApp({ perfProfile: profile.path, perfCertificateArn: 'arn:aws:acm:ap-northeast-2:111111111111:certificate/01234567-0123-0123-0123-0123456789ab' });
  for (const stack of [built.evidence, built.edge!]) {
    const buckets: any[] = Object.values(Template.fromStack(stack).findResources('AWS::S3::Bucket'));
    expect(buckets.every(b => b.DeletionPolicy === 'Delete')).toBe(true);
    Template.fromStack(stack).resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    const fn: any = Object.values(Template.fromStack(stack).findResources('AWS::Lambda::Function'))[0];
    expect(fn.Properties.LoggingConfig).toBeDefined();
    expect(JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Policy'))).toContain('NoImplicitCleanupLogGroup');
    Template.fromStack(stack).resourceCountIs('AWS::Logs::LogGroup', stack === built.edge ? 2 : 1);
  }
  expect(Object.values(Template.fromStack(buildPerfApp().evidence).findResources('AWS::S3::Bucket'))[0].DeletionPolicy).toBe('Retain');
});

test('현행 inventory는 evidence/guard/new ECR도 삭제 대상으로 기록한다', () => {
  const outputs = collectPerfOutputs([describeStacks({}, { perfProfile: profile.path })]);
  const items = cleanupInventory(outputs, ENVIRONMENT_ID);
  expect(items.every(item => item.retain === false)).toBe(true);
  expect(items.filter(item => item.resource_type === 'AWS::ECR::Repository')).toHaveLength(2);
  expect(items.some(item => String(item.identifier).includes('PerfGuardrailStack'))).toBe(true);
  expect(residualReport(ENVIRONMENT_ID, { ResourceTagMappingList: [] }, [{ Stacks: [{ StackName: 'PerfEvidenceStack', StackStatus: 'CREATE_COMPLETE' }] }], true).complete).toBe(false);
});
