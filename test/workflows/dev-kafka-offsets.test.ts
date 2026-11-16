import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const { load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const readWorkflow = (name: string): any => load(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const workflow = readWorkflow('dev-kafka-offsets.yml');
const job = workflow.jobs.offsets;
const steps: any[] = job.steps;
const command = (phase: string): any => steps.find(step => step.run === `node scripts/dev-kafka-offsets.mjs ${phase}`);
const credentials = steps.filter(step => step.uses?.startsWith('aws-actions/configure-aws-credentials@'));

describe('dev Kafka offset 수동 workflow', () => {
  test('보호된 develop 수동 실행만 허용하고 실행 중인 Job을 취소하지 않는다', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
    expect(Object.keys(workflow.jobs)).toEqual(['offsets']);
    expect(job.environment).toBe('infra-dev-deploy');
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job['timeout-minutes']).toBe(20);
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
    expect(workflow.concurrency).toEqual({ group: 'dev-kafka-offsets', 'cancel-in-progress': false });
    const permits = new Function('github', `return (${job.if});`);
    for (const [repository, ref, event, expected] of [
      ['soma-376/infra', 'refs/heads/develop', 'workflow_dispatch', true],
      ['other/infra', 'refs/heads/develop', 'workflow_dispatch', false],
      ['soma-376/infra', 'refs/heads/main', 'workflow_dispatch', false],
      ['soma-376/infra', 'refs/heads/feature/test', 'workflow_dispatch', false],
      ['soma-376/infra', 'refs/heads/develop', 'push', false],
    ]) expect(permits({ repository, ref, event_name: event })).toBe(expected);
  });

  test('기본값은 plan이며 입력은 shell에 삽입하지 않고 환경변수로 전달한다', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(Object.keys(inputs)).toEqual(['mode', 'partition', 'to_offset', 'to_datetime']);
    expect(inputs.mode).toMatchObject({ type: 'choice', options: ['plan', 'execute'], default: 'plan', required: true });
    expect(job.env).toMatchObject({
      AWS_ACCOUNT_ID: '${{ vars.AWS_ACCOUNT_ID }}',
      CDK_DEPLOY_ROLE_ARN: '${{ vars.CDK_DEPLOY_ROLE_ARN }}',
      KAFKA_OFFSETS_MODE: '${{ inputs.mode }}',
      KAFKA_OFFSETS_PARTITION: '${{ inputs.partition }}',
      KAFKA_OFFSETS_TO_OFFSET: '${{ inputs.to_offset }}',
      KAFKA_OFFSETS_TO_DATETIME: '${{ inputs.to_datetime }}',
    });
    for (const step of steps) expect(step.run ?? '').not.toContain('${{ inputs.');
    expect(steps.indexOf(command('validate'))).toBeLessThan(steps.indexOf(credentials[0]));
  });

  test('기존 deploy 역할로 대상을 읽은 뒤 operator로 전환해서 한 프로세스로 실행한다', () => {
    expect(credentials).toHaveLength(2);
    expect(credentials[0].with['role-to-assume']).toBe('${{ env.CDK_DEPLOY_ROLE_ARN }}');
    expect(credentials[1].with['role-to-assume']).toBe('${{ steps.target.outputs.operator_role_arn }}');
    expect(credentials[1].with['role-chaining']).toBe(true);
    expect(credentials[1].with['role-skip-session-tagging']).toBe(true);
    for (const step of credentials) {
      expect(step.with['aws-region']).toBe('ap-northeast-2');
      expect(step.with['allowed-account-ids']).toBe('${{ env.AWS_ACCOUNT_ID }}');
      expect(step.with['role-duration-seconds']).toBe(3600);
      expect(step.with['output-credentials']).toBeUndefined();
    }
    expect(command('prepare').id).toBe('target');
    expect(steps.indexOf(credentials[0])).toBeLessThan(steps.indexOf(command('prepare')));
    expect(steps.indexOf(command('prepare'))).toBeLessThan(steps.indexOf(credentials[1]));
    expect(steps.indexOf(credentials[1])).toBeLessThan(steps.indexOf(command('run')));
    expect(steps.filter(step => step.run === 'node scripts/dev-kafka-offsets.mjs run')).toHaveLength(1);
    expect(steps.some(step => step.uses?.includes('artifact') || step.uses?.includes('github-app-token'))).toBe(false);
  });

  test('Action과 실행 도구 버전을 고정하고 다운로드 checksum을 확인한다', () => {
    for (const step of steps.filter(step => step.uses)) expect(step.uses).toMatch(/^[\w/-]+@[0-9a-f]{40}$/);
    expect(steps.find(step => step.uses?.startsWith('actions/checkout@')).with).toEqual({ ref: '${{ github.sha }}', 'persist-credentials': false });
    expect(steps.find(step => step.uses?.startsWith('actions/setup-node@')).with['node-version']).toBe('24');
    const commands = steps.map(step => step.run ?? '').join('\n');
    expect(commands).toContain('helm-v3.22.0-linux-amd64.tar.gz');
    expect(commands).toContain('1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb');
    expect(commands).toContain('https://dl.k8s.io/release/v1.36.0/bin/linux/amd64/kubectl.sha256');
    expect(commands).toContain('echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check');
    expect(commands).toContain('plugin/1.2.896.0/ubuntu_64bit/session-manager-plugin.deb');
    expect(commands).toContain('53f51fcc67314a4bf85888a38a3967cd41f8d0f28a60a9469a63acf935ba713e');
    expect(commands).not.toMatch(/stable\.txt|latest/);
  });

  test('PR의 AWS 없는 검증이 새 workflow와 실행 script 변경을 검사한다', () => {
    const pr = readWorkflow('dev-cdk-pr.yml');
    for (const path of [
      'scripts/dev-kafka-offsets.mjs', 'test/scripts/dev-kafka-offsets.test.ts',
      'test/workflows/dev-kafka-offsets.test.ts', '.github/workflows/dev-kafka-offsets.yml',
    ]) expect(pr.on.pull_request.paths).toContain(path);
    const tests = pr.jobs.validate.steps.find((step: any) => step.run?.startsWith('npm test -- --runInBand'));
    expect(tests.run).toContain('test/scripts/dev-kafka-offsets.test.ts');
    expect(tests.run).toContain('test/workflows/dev-kafka-offsets.test.ts');
    expect(pr.jobs.validate.steps.some((step: any) => step.uses?.startsWith('aws-actions/'))).toBe(false);
  });
});
