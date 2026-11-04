import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(__dirname, '../..');
const applicationScript = readFileSync(join(root, 'helm/dev/gitops/health/application.lua'), 'utf8');
const kafkaScript = readFileSync(join(root, 'helm/dev/gitops/health/kafka.lua'), 'utf8');
const source = (sha = 'a'.repeat(40)) => ({ repoURL: 'https://github.com/soma-376/infra.git', targetRevision: sha, path: 'helm/dev/workloads/spring-app' });
const destination = { server: 'https://kubernetes.default.svc', namespace: 'pulsemetry-dev' };
const application = () => ({
  metadata: { annotations: {} },
  spec: { sources: [source(), { repoURL: 'https://github.com/soma-376/infra-generated-values.git', targetRevision: 'b'.repeat(40), ref: 'values' }], destination },
  status: { sync: { status: 'Synced', comparedTo: { sources: [source(), { repoURL: 'https://github.com/soma-376/infra-generated-values.git', targetRevision: 'b'.repeat(40), ref: 'values' }], destination }, revisions: ['a'.repeat(40), 'b'.repeat(40)] }, health: { status: 'Healthy' }, operationState: { phase: 'Succeeded' } },
});

describe('Argo 3.5.7과 같은 gopher-lua 1.1.2의 실제 health 실행', () => {
  let temporary: string;
  let executable: string;
  beforeAll(() => {
    temporary = mkdtempSync(join(tmpdir(), 'argocd-health-'));
    executable = join(temporary, 'health-lua');
    const built = spawnSync(process.env.GO_BIN ?? 'go', ['build', '-mod=readonly', '-o', executable, '.'], {
      cwd: join(root, 'test/helm/health-lua'), encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, GOCACHE: process.env.GOCACHE ?? join(tmpdir(), 'pulsemetry-argocd-health-go-cache'), GOMODCACHE: process.env.GOMODCACHE ?? join(tmpdir(), 'pulsemetry-argocd-health-mod') },
    });
    expect({ status: built.status, error: built.error?.message, stderr: built.stderr }).toEqual({ status: 0, error: undefined, stderr: '' });
  }, 130_000);
  afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

  function health(object: any, script = applicationScript) {
    const result = spawnSync(executable, [], { input: JSON.stringify({ object, script }), encoding: 'utf8', timeout: 5000 });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    return JSON.parse(result.stdout).status;
  }

  test('현재 C/V·destination·Synced·Healthy·완료 operation만 통과한다', () => {
    expect(health(application())).toBe('Healthy');
    const single: any = application();
    single.spec.source = single.spec.sources[0]; delete single.spec.sources;
    single.status.sync.comparedTo.source = single.status.sync.comparedTo.sources[0]; delete single.status.sync.comparedTo.sources;
    single.status.sync.revision = single.status.sync.revisions[0]; delete single.status.sync.revisions;
    expect(health(single)).toBe('Healthy');
  });

  test.each([
    ['상태 없음', (v: any) => { delete v.status; }, 'Progressing'],
    ['과거 C', (v: any) => { v.status.sync.revisions[0] = 'c'.repeat(40); }, 'Progressing'],
    ['과거 V', (v: any) => { v.status.sync.revisions[1] = 'c'.repeat(40); }, 'Progressing'],
    ['revision 누락', (v: any) => { v.status.sync.revisions.pop(); }, 'Progressing'],
    ['과거 비교 spec', (v: any) => { v.status.sync.comparedTo.sources[0].path = 'old'; }, 'Progressing'],
    ['과거 destination', (v: any) => { v.status.sync.comparedTo.destination = { ...destination, namespace: 'other' }; }, 'Progressing'],
    ['가변 source', (v: any) => { v.spec.sources[0].targetRevision = v.status.sync.comparedTo.sources[0].targetRevision = v.status.sync.revisions[0] = 'develop'; }, 'Progressing'],
    ['OutOfSync', (v: any) => { v.status.sync.status = 'OutOfSync'; }, 'Progressing'],
    ['Healthy 없음', (v: any) => { delete v.status.health; }, 'Progressing'],
    ['하위 실패', (v: any) => { v.status.health.status = 'Degraded'; }, 'Degraded'],
    ['operation 요청', (v: any) => { v.operation = { sync: {} }; }, 'Progressing'],
    ['실행 중', (v: any) => { v.status.operationState.phase = 'Running'; }, 'Progressing'],
    ['실패 operation', (v: any) => { v.status.operationState.phase = 'Failed'; }, 'Degraded'],
    ['오류 operation', (v: any) => { v.status.operationState.phase = 'Error'; }, 'Degraded'],
    ['비교 오류', (v: any) => { v.status.conditions = [{ type: 'ComparisonError' }]; }, 'Degraded'],
    ['인계 차단', (v: any) => { v.metadata.annotations['pulsemetry.io/handoff-status'] = 'blocked'; }, 'Suspended'],
    ['reconcile 중지', (v: any) => { v.metadata.annotations['argocd.argoproj.io/skip-reconcile'] = 'true'; }, 'Suspended'],
  ])('%s는 다음 wave를 열지 않는다', (_name, mutate, expected) => {
    const fixture = application();
    (mutate as (value: any) => void)(fixture);
    expect(health(fixture)).toBe(expected);
  });

  test('Kafka는 현재 generation의 Ready만 통과시키고 NotReady를 우선한다', () => {
    const fixture: any = { metadata: { generation: 3 }, status: { observedGeneration: 3, conditions: [{ type: 'Ready', status: 'True' }] } };
    expect(health(fixture, kafkaScript)).toBe('Healthy');
    fixture.status.observedGeneration = 2;
    expect(health(fixture, kafkaScript)).toBe('Progressing');
    fixture.status.observedGeneration = 3;
    fixture.status.conditions.push({ type: 'NotReady', status: 'True' });
    expect(health(fixture, kafkaScript)).toBe('Degraded');
    fixture.status.conditions = [];
    expect(health(fixture, kafkaScript)).toBe('Progressing');
    expect(health({}, kafkaScript)).toBe('Progressing');
  });

  test('파일·프로세스·네트워크 표준 library를 열지 않는다', () => {
    expect(health({}, 'if os ~= nil or io ~= nil or package ~= nil or string ~= nil then error("표준 library가 열렸다") end return { status = "Healthy", message = "" }')).toBe('Healthy');
  });
});
