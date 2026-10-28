import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const { load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const readWorkflow = (name: string): any => load(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const pr = readWorkflow('dev-cdk-pr.yml');
const cd = readWorkflow('dev-cdk-deploy.yml');
const jobs = [pr.jobs.validate, pr.jobs.plan, cd.jobs.plan, cd.jobs.deploy];
const steps = (job: any): any[] => job.steps;
const action = (job: any, name: string): any => steps(job).find(step => step.uses?.startsWith(`${name}@`));
const command = (job: any, phase: string): any => steps(job).find(step =>
  step.run?.includes(`node scripts/dev-cdk-pipeline.mjs ${phase} --directory`));
const testTargets = ['test/dev', 'test/prod', 'test/cicd', 'test/scripts/dev-cdk-pipeline.test.ts', 'test/workflows/dev-cdk.test.ts'];

// trigger가 cicd·Helm 변경을 dev 배포로 승격하지 않는지 실제 경로 예제로 확인한다.
function matchesPath(patterns: string[], path: string): boolean {
  return patterns.some(pattern => {
    const escape = (value: string) => value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    const expression = pattern.split('**').map(part => part.split('*').map(escape).join('[^/]*')).join('.*');
    return new RegExp(`^${expression}$`).test(path);
  });
}
function stepIndex(job: any, target: any): number { return steps(job).indexOf(target); }

describe('dev CDK workflow의 실행·승인 경계', () => {
  test('PR은 develop만 대상으로 하며 fork에는 AWS 없는 검증만 제공한다', () => {
    expect(Object.keys(pr.on)).toEqual(['pull_request']);
    expect(pr.on.pull_request.branches).toEqual(['develop']);
    expect(pr.jobs.validate.environment).toBeUndefined();
    expect(pr.jobs.validate.permissions?.['id-token']).toBeUndefined();
    expect(action(pr.jobs.validate, 'aws-actions/configure-aws-credentials')).toBeUndefined();
    expect(pr.jobs.plan.needs).toBe('validate');
    expect(pr.jobs.plan.if).toBe('github.event.pull_request.head.repo.full_name == github.repository');
    expect(pr.jobs.plan.environment).toBe('infra-dev-pr-plan');
    expect(pr.concurrency).toEqual({
      group: 'dev-cdk-pr-${{ github.event.pull_request.number }}',
      'cancel-in-progress': true,
    });
    expect(command(pr.jobs.plan, 'plan')).toBeDefined();
    expect(command(pr.jobs.plan, 'deploy')).toBeUndefined();
  });

  test('CD는 develop push의 plan→승인된 deploy 두 job을 전체 직렬화한다', () => {
    expect(Object.keys(cd.on)).toEqual(['push']);
    expect(cd.on.push.branches).toEqual(['develop']);
    expect(Object.keys(cd.jobs)).toEqual(['plan', 'deploy']);
    expect(cd.jobs.plan.environment).toBe('infra-dev-plan');
    expect(cd.jobs.deploy.environment).toBe('infra-dev-deploy');
    expect(cd.jobs.deploy.needs).toBe('plan');
    expect(cd.jobs.deploy.if).toBe("needs.plan.outputs.plan_sha256 != '' && needs.plan.outputs.plan_artifact_id != ''");
    expect(cd.concurrency['cancel-in-progress']).toBe(false);
    expect(cd.concurrency.group).toBe('infra-dev-cloudformation-deploy');
    expect(cd.concurrency.group).not.toContain('${{');
    expect(cd.jobs.plan.concurrency).toBeUndefined();
    expect(cd.jobs.deploy.concurrency).toBeUndefined();
    expect(cd.jobs.plan['timeout-minutes']).toBe(20);
    expect(cd.jobs.deploy['timeout-minutes']).toBe(75);
  });

  test('CDK·profile·의존성·pipeline 변경은 검사하고 cicd·Helm 전용 변경은 자동 배포하지 않는다', () => {
    const required = [
      'bin/infra.ts', 'lib/dev/app.ts', 'lib/common/config.ts', 'config/dev/deployment.json',
      'package.json', 'package-lock.json', 'cdk.json', 'tsconfig.json', 'jest.config.js',
      'scripts/dev-cdk-pipeline.mjs', 'scripts/dev-cdk-pipeline.cjs',
      'test/scripts/dev-cdk-pipeline.test.ts', 'test/workflows/dev-cdk.test.ts',
      '.github/workflows/dev-cdk-deploy.yml',
    ];
    for (const path of required) {
      expect(matchesPath(pr.on.pull_request.paths, path)).toBe(true);
      expect(matchesPath(cd.on.push.paths, path)).toBe(true);
    }
    for (const path of ['lib/cicd/deploy-stack.ts', 'test/cicd/deploy-stack.test.ts', 'lib/prod/app.ts']) {
      expect(matchesPath(pr.on.pull_request.paths, path)).toBe(true);
      expect(matchesPath(cd.on.push.paths, path)).toBe(false);
    }
    for (const path of ['helm/dev/runtime/values.yaml', 'config/dev/runtime.yaml', 'frontend/main.tf']) {
      expect(matchesPath(cd.on.push.paths, path)).toBe(false);
    }
  });

  test('PR와 CD plan은 승인 전 AWS 없는 build·CDK·pipeline 테스트를 수행한다', () => {
    for (const job of [pr.jobs.validate, cd.jobs.plan]) {
      const install = steps(job).find(step => step.run?.startsWith('npm ci'));
      const build = steps(job).find(step => step.run?.startsWith('npm run build'));
      const tests = steps(job).find(step => step.run?.startsWith('npm test -- --runInBand'));
      expect(install).toBeDefined();
      expect(build).toBeDefined();
      expect(tests).toBeDefined();
      for (const target of testTargets) expect(tests.run).toContain(target);
      expect(stepIndex(job, install)).toBeLessThan(stepIndex(job, build));
      expect(stepIndex(job, build)).toBeLessThan(stepIndex(job, tests));
      const credentials = action(job, 'aws-actions/configure-aws-credentials');
      if (credentials) expect(stepIndex(job, tests)).toBeLessThan(stepIndex(job, credentials));
    }
  });
});

describe('dev CDK workflow의 자격·artifact 연결', () => {
  test('Actions는 commit으로 고정하고 Node 24·서울 리전·허용 계정·1시간 세션을 사용한다', () => {
    expect(pr.permissions).toEqual({ contents: 'read' });
    expect(cd.permissions).toEqual({ contents: 'read' });
    for (const job of jobs) {
      for (const step of steps(job).filter(step => step.uses)) expect(step.uses).toMatch(/^[\w/-]+@[0-9a-f]{40}$/);
      expect(action(job, 'actions/checkout').with['persist-credentials']).toBe(false);
      expect(action(job, 'actions/setup-node').with['node-version']).toBe('24');
      const credentials = action(job, 'aws-actions/configure-aws-credentials');
      if (!credentials) continue;
      expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
      expect(credentials.with['aws-region']).toBe('ap-northeast-2');
      expect(credentials.with['allowed-account-ids']).toBe('${{ env.AWS_ACCOUNT_ID }}');
      expect(credentials.with['role-duration-seconds']).toBe(3600);
      expect(credentials.with['output-credentials']).toBeUndefined();
      expect(stepIndex(job, steps(job).find(step => step.run?.startsWith('npm ci')))).toBeLessThan(stepIndex(job, credentials));
    }
    for (const job of [pr.jobs.plan, cd.jobs.plan]) {
      expect(action(job, 'aws-actions/configure-aws-credentials').with['role-to-assume']).toBe('${{ env.CDK_DIFF_ROLE_ARN }}');
    }
    expect(action(cd.jobs.deploy, 'aws-actions/configure-aws-credentials').with['role-to-assume']).toBe('${{ env.CDK_DEPLOY_ROLE_ARN }}');
  });

  test('같은 run의 artifact ID·plan hash를 전달하고 AWS 인증 전에 로컬 검증한다', () => {
    expect(cd.jobs.plan.outputs).toEqual({
      plan_sha256: '${{ steps.plan.outputs.plan_sha256 }}',
      plan_artifact_id: '${{ steps.upload.outputs.artifact-id }}',
    });
    const upload = steps(cd.jobs.plan).find(step => step.id === 'upload');
    expect(upload.if).toBe("success() && steps.plan.outputs.plan_sha256 != ''");
    expect(upload.with.path).toContain('/dev-cdk-plan/plan.json');
    expect(upload.with.path).toContain('/dev-cdk-plan/payload');
    expect(upload.with['include-hidden-files']).toBe(true);
    const download = action(cd.jobs.deploy, 'actions/download-artifact');
    expect(download.with['artifact-ids']).toBe('${{ needs.plan.outputs.plan_artifact_id }}');
    expect(download.with.name).toBeUndefined();
    expect(download.with['github-token']).toBeUndefined();
    expect(download.with['run-id']).toBeUndefined();
    expect(download.with.repository).toBeUndefined();
    expect(download.with.path).toBe('${{ runner.temp }}/dev-cdk-plan');
    expect(download.with['merge-multiple']).toBe(true);
    expect(cd.jobs.deploy.env.PLAN_SHA256).toBe('${{ needs.plan.outputs.plan_sha256 }}');
    expect(cd.jobs.deploy.env.PLAN_ARTIFACT_ID).toBe(download.with['artifact-ids']);
    expect(cd.jobs.deploy.env.DOWNLOADED_ARTIFACT_ID).toBe(download.with['artifact-ids']);
    const verify = command(cd.jobs.deploy, 'verify');
    const credentials = action(cd.jobs.deploy, 'aws-actions/configure-aws-credentials');
    const deploy = command(cd.jobs.deploy, 'deploy');
    expect(stepIndex(cd.jobs.deploy, download)).toBeLessThan(stepIndex(cd.jobs.deploy, verify));
    expect(stepIndex(cd.jobs.deploy, verify)).toBeLessThan(stepIndex(cd.jobs.deploy, credentials));
    expect(stepIndex(cd.jobs.deploy, credentials)).toBeLessThan(stepIndex(cd.jobs.deploy, deploy));
  });

  test('CD 두 job은 같은 SHA를 checkout하고 deploy에서 재합성·무조건 배포하지 않는다', () => {
    for (const job of [cd.jobs.plan, cd.jobs.deploy]) expect(action(job, 'actions/checkout').with.ref).toBe('${{ github.sha }}');
    expect(command(cd.jobs.deploy, 'plan')).toBeUndefined();
    expect(steps(cd.jobs.deploy).map(step => step.run ?? '').join('\n')).not.toMatch(/npm run (?:build|synth)|cdk synth|--force|--hotswap/);
    for (const job of jobs) {
      expect(job['continue-on-error']).toBeUndefined();
      for (const step of steps(job)) {
        expect(step['continue-on-error']).toBeUndefined();
        expect(step.run ?? '').not.toMatch(/\|\|\s*true|cdk diff[^\n]*--fail/);
      }
    }
    expect(pr.defaults.run.shell).toBe('bash');
    expect(cd.defaults.run.shell).toBe('bash');
  });

  test('성공·실패 실행 결과를 항상 14일 보관하며 초기 실패도 결과 파일로 남긴다', () => {
    for (const job of [pr.jobs.plan, cd.jobs.plan, cd.jobs.deploy]) {
      const uploads = steps(job).filter(step => step.uses?.startsWith('actions/upload-artifact@'));
      for (const upload of uploads) {
        expect(upload.with['retention-days']).toBe(14);
        expect(upload.with['if-no-files-found']).toBe('error');
        expect(upload.with.name).toContain('${{ github.run_id }}-${{ github.run_attempt }}');
      }
      const resultUpload = uploads.find(step => step.with.path.includes('/result*.json'));
      expect(resultUpload.if).toBe('always()');
      expect(resultUpload.with.path).toContain('/logs');
      const fallback = steps(job).find(step => step.env?.WORKFLOW_JOB_STATUS);
      expect(fallback.if).toBe('always()');
      expect(stepIndex(job, fallback)).toBeLessThan(stepIndex(job, resultUpload));

      const directory = mkdtempSync(join(tmpdir(), 'dev-cdk-workflow-'));
      try {
        const summary = join(directory, 'summary.md');
        const resultPath = join(directory, 'dev-cdk-plan/result-workflow.json');
        const env = { ...process.env, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary, WORKFLOW_JOB_STATUS: 'failure' };
        const initial = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', fallback.run], { env, encoding: 'utf8' });
        expect(initial.status).toBe(0);
        expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual({ phase: 'workflow', status: 'failure' });
        expect(readFileSync(summary, 'utf8')).toContain('failure');

        const helperResult = JSON.stringify({ phase: 'deploy', status: 'failure', completedStacks: ['DevNetworkStack'] });
        const helperResultPath = join(directory, 'dev-cdk-plan/result-deploy.json');
        writeFileSync(helperResultPath, helperResult);
        const existing = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', fallback.run], { env, encoding: 'utf8' });
        expect(existing.status).toBe(0);
        expect(readFileSync(helperResultPath, 'utf8')).toBe(helperResult);
        expect(JSON.parse(readFileSync(resultPath, 'utf8')).status).toBe('failure');
      } finally { rmSync(directory, { recursive: true, force: true }); }
    }
  });
});
