import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const { load } = require('js-yaml');
const root = resolve(__dirname, '../..');
const readWorkflow = (name: string): any => load(readFileSync(join(root, '.github/workflows', name), 'utf8'));
const pr = readWorkflow('dev-cdk-pr.yml');
const cd = readWorkflow('dev-cdk-deploy.yml');
const inputs = readWorkflow('dev-deployment-inputs.yml');
const jobs = [pr.jobs.validate, pr.jobs.plan, cd.jobs.plan, cd.jobs.deploy, cd.jobs.publish];
const steps = (job: any): any[] => job.steps;
const action = (job: any, name: string): any => steps(job).find(step => step.uses?.startsWith(`${name}@`));
const command = (job: any, phase: string): any => steps(job).find(step =>
  step.run?.includes(`node scripts/dev-cdk-pipeline.mjs ${phase} --directory`));
const valuesTestTargets = [
  'test/scripts/backend-image-inputs.test.ts', 'test/scripts/dev-generated-values-inputs.test.ts',
  'test/scripts/dev-generated-values-sync.test.ts', 'test/scripts/validate-generated-values.test.ts',
  'test/helm/values-reader-rbac.test.ts',
];
const testTargets = ['test/dev', 'test/prod', 'test/cicd', 'test/scripts/dev-cdk-pipeline.test.ts', 'test/workflows/dev-cdk.test.ts', ...valuesTestTargets];

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

  test('CD는 develop push·수동 실행의 plan→승인된 deploy→사본 게시를 전체 직렬화한다', () => {
    expect(Object.keys(cd.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(cd.on.push.branches).toEqual(['develop']);
    expect(cd.on.workflow_dispatch).toEqual({});
    expect(Object.keys(cd.jobs)).toEqual(['plan', 'deploy', 'publish']);
    expect(cd.jobs.plan.environment).toBe('infra-dev-plan');
    expect(cd.jobs.deploy.environment).toBe('infra-dev-deploy');
    expect(cd.jobs.publish.environment).toBe('infra-dev-deploy');
    expect(cd.jobs.deploy.needs).toBe('plan');
    expect(cd.jobs.deploy.if).toBe("needs.plan.outputs.plan_sha256 != '' && needs.plan.outputs.plan_artifact_id != ''");
    expect(cd.concurrency['cancel-in-progress']).toBe(false);
    expect(cd.concurrency.group).toBe('infra-dev-cloudformation-deploy');
    expect(cd.concurrency.group).not.toContain('${{');
    expect(cd.jobs.plan.concurrency).toBeUndefined();
    expect(cd.jobs.deploy.concurrency).toBeUndefined();
    expect(cd.jobs.publish.concurrency).toBeUndefined();
    expect(cd.jobs.plan['timeout-minutes']).toBe(20);
    expect(cd.jobs.deploy['timeout-minutes']).toBe(75);
    expect(cd.jobs.publish['timeout-minutes']).toBe(30);
  });

  test.each([
    ['push', 'soma-376/infra', 'refs/heads/develop', true],
    ['workflow_dispatch', 'soma-376/infra', 'refs/heads/develop', true],
    ['workflow_dispatch', 'other/infra', 'refs/heads/develop', false],
    ['workflow_dispatch', 'soma-376/infra', 'refs/heads/main', false],
    ['workflow_dispatch', 'soma-376/infra', 'refs/heads/feature/test', false],
    ['workflow_dispatch', 'soma-376/infra', 'refs/tags/develop', false],
    ['pull_request', 'soma-376/infra', 'refs/heads/develop', false],
    ['repository_dispatch', 'soma-376/infra', 'refs/heads/develop', false],
  ])('CD plan의 job 진입 조건: %s %s %s → %s', (event, repository, ref, allowed) => {
    // 이 조건에서 사용하는 문자열 비교·논리 연산만 평가해 잘못된 ref가 AWS 단계에 진입하지 못하는지 확인한다.
    const permitsPlan = new Function('github', `return (${cd.jobs.plan.if});`);
    expect(permitsPlan({ event_name: event, repository, ref })).toBe(allowed);
  });

  test('CDK·profile·의존성·pipeline 변경은 검사하고 cicd·Helm 전용 변경은 자동 배포하지 않는다', () => {
    const required = [
      'bin/infra.ts', 'lib/dev/app.ts', 'lib/common/config.ts', 'config/dev/deployment.json',
      'package.json', 'package-lock.json', 'cdk.json', 'tsconfig.json', 'jest.config.js',
      'scripts/dev-cdk-pipeline.mjs', 'scripts/dev-cdk-pipeline.cjs',
      'config/dev/runtime.yaml', 'scripts/eks-values.mjs', 'scripts/backend-image-inputs.mjs',
      'scripts/dev-generated-values-inputs.mjs', 'scripts/dev-generated-values-sync.mjs',
      'scripts/validate-generated-values.mjs', 'scripts/generated-values-github.mjs',
      'test/scripts/dev-cdk-pipeline.test.ts', 'test/workflows/dev-cdk.test.ts',
      ...valuesTestTargets.filter(path => !path.startsWith('test/helm/')),
      'test/scripts/fixtures/backend-image-publication.json',
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
    for (const path of ['docs/adr/0048-dev-cloudformation-cicd.md', 'helm/dev/runtime/values.yaml', 'helm/dev/platform/base/templates/values-reader-rbac.yaml', 'test/helm/values-reader-rbac.test.ts', 'frontend/main.tf']) {
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
      expect(job.permissions).toEqual({ contents: 'read', 'id-token': 'write', ...(job === cd.jobs.publish ? { actions: 'read' } : {}) });
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
    expect(action(cd.jobs.publish, 'aws-actions/configure-aws-credentials').with['role-to-assume']).toBe('${{ env.CDK_DEPLOY_ROLE_ARN }}');
  });

  test('같은 run의 artifact ID·plan hash를 전달하고 AWS 인증 전에 로컬 검증한다', () => {
    expect(cd.jobs.plan.outputs).toEqual({
      plan_sha256: '${{ steps.plan.outputs.plan_sha256 }}',
      plan_artifact_id: '${{ steps.upload.outputs.artifact-id }}',
      generated_values_enabled: '${{ steps.plan.outputs.generated_values_enabled }}',
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

  test('CD 세 job은 같은 SHA를 checkout하고 deploy에서 재합성·무조건 배포하지 않는다', () => {
    for (const job of [cd.jobs.plan, cd.jobs.deploy, cd.jobs.publish]) expect(action(job, 'actions/checkout').with.ref).toBe('${{ github.sha }}');
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

describe('승인된 generated values 사본 workflow', () => {
  test.each([
    ['true', 'success', 'hash', 'artifact', true],
    ['false', 'success', 'hash', 'artifact', false],
    ['', 'success', 'hash', 'artifact', false],
    ['true', 'failure', 'hash', 'artifact', false],
    ['true', 'skipped', 'hash', 'artifact', false],
    ['true', 'success', '', 'artifact', false],
    ['true', 'success', 'hash', '', false],
  ])('승인 enabled=%s deploy=%s receipt=%s/%s → %s', (enabled, deployResult, receiptHash, receiptId, allowed) => {
    const job = cd.jobs.publish;
    expect(job.needs).toEqual(['plan', 'deploy']);
    // 현재 변수값과 현재 run attempt가 아니라 원본 성공 job의 출력을 사용한다.
    expect(job.if).not.toMatch(/vars\.|run_attempt|run_id/);
    const permitsPublish = new Function('needs', `return (${job.if});`);
    expect(permitsPublish({ plan: { outputs: { generated_values_enabled: enabled } },
      deploy: { result: deployResult, outputs: { receipt_sha256: receiptHash, receipt_artifact_id: receiptId } } })).toBe(allowed);
    expect(job.env.GENERATED_VALUES_SYNC_ENABLED).toBeUndefined();
  });

  test('CD plan의 명시 활성화에만 backend 조회 App token을 만들고 PR에서는 만들지 않는다', () => {
    const token = action(cd.jobs.plan, 'actions/create-github-app-token');
    expect(token.uses).toBe('actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349');
    expect(token.id).toBe('backend-token');
    expect(token.if).toBe("vars.GENERATED_VALUES_SYNC_ENABLED == 'true'");
    expect(token.with).toEqual({
      'app-id': '${{ vars.GENERATED_VALUES_APP_ID }}', 'private-key': '${{ secrets.GENERATED_VALUES_APP_PRIVATE_KEY }}',
      owner: 'soma-376', repositories: 'pulsemetry-backend', 'permission-actions': 'read', 'permission-contents': 'read',
    });
    const plan = command(cd.jobs.plan, 'plan');
    expect(stepIndex(cd.jobs.plan, token)).toBeLessThan(stepIndex(cd.jobs.plan, plan));
    expect(plan.env.BACKEND_GH_TOKEN).toBe('${{ steps.backend-token.outputs.token }}');
    expect(cd.jobs.plan.env.GENERATED_VALUES_SYNC_ENABLED).toBe('${{ vars.GENERATED_VALUES_SYNC_ENABLED }}');
    for (const job of [pr.jobs.validate, pr.jobs.plan, inputs.jobs.validate]) {
      expect(action(job, 'actions/create-github-app-token')).toBeUndefined();
      expect(JSON.stringify(job)).not.toMatch(/BACKEND_GH_TOKEN|VALUES_GH_TOKEN|GENERATED_VALUES_APP_PRIVATE_KEY/);
    }
  });

  test('성공한 deploy만 정제 receipt를 업로드하고 원본 hash·artifact ID를 전달한다', () => {
    const deploy = command(cd.jobs.deploy, 'deploy');
    expect(deploy.id).toBe('deploy');
    expect(cd.jobs.deploy.outputs).toEqual({
      receipt_sha256: '${{ steps.deploy.outputs.receipt_sha256 }}', receipt_artifact_id: '${{ steps.receipt.outputs.artifact-id }}',
    });
    const receipt = steps(cd.jobs.deploy).find(step => step.id === 'receipt');
    expect(receipt.if).toBe("success() && steps.deploy.outputs.receipt_sha256 != ''");
    expect(receipt.with.name).toBe('dev-cdk-receipt-${{ github.run_id }}-${{ github.run_attempt }}');
    expect(receipt.with.path).toBe('${{ runner.temp }}/dev-cdk-plan/deployment-receipt.json');
    expect(stepIndex(cd.jobs.deploy, deploy)).toBeLessThan(stepIndex(cd.jobs.deploy, receipt));
    const job = cd.jobs.publish;
    expect(job.env.PLAN_SHA256).toBe('${{ needs.plan.outputs.plan_sha256 }}');
    expect(job.env.PLAN_ARTIFACT_ID).toBe('${{ needs.plan.outputs.plan_artifact_id }}');
    expect(job.env.DOWNLOADED_ARTIFACT_ID).toBe('${{ needs.plan.outputs.plan_artifact_id }}');
    expect(job.env.RECEIPT_SHA256).toBe('${{ needs.deploy.outputs.receipt_sha256 }}');
    expect(job.env.RECEIPT_ARTIFACT_ID).toBe('${{ needs.deploy.outputs.receipt_artifact_id }}');
    const downloads = steps(job).filter(step => step.uses?.startsWith('actions/download-artifact@'));
    expect(downloads.map(step => step.with['artifact-ids'])).toEqual([
      '${{ needs.plan.outputs.plan_artifact_id }}', '${{ needs.deploy.outputs.receipt_artifact_id }}',
    ]);
    for (const download of downloads) {
      expect(download.with.name).toBeUndefined();
      expect(download.with.repository).toBeUndefined();
      expect(download.with['run-id']).toBeUndefined();
      expect(download.with.path).toBe('${{ runner.temp }}/dev-cdk-plan');
      expect(download.with['merge-multiple']).toBe(true);
    }
  });

  test('publisher는 다운로드→로컬 무결성→AWS→제한된 private token→게시 순서다', () => {
    const job = cd.jobs.publish;
    const verify = command(job, 'verify-publish');
    const credentials = action(job, 'aws-actions/configure-aws-credentials');
    const token = action(job, 'actions/create-github-app-token');
    const publish = steps(job).find(step => step.run?.startsWith('node scripts/dev-generated-values-sync.mjs'));
    for (const download of steps(job).filter(step => step.uses?.startsWith('actions/download-artifact@'))) {
      expect(stepIndex(job, download)).toBeLessThan(stepIndex(job, verify));
    }
    expect(stepIndex(job, verify)).toBeLessThan(stepIndex(job, credentials));
    expect(stepIndex(job, credentials)).toBeLessThan(stepIndex(job, token));
    expect(stepIndex(job, token)).toBeLessThan(stepIndex(job, publish));
    expect(token.id).toBe('values-token');
    expect(token.with).toEqual({
      'app-id': '${{ vars.GENERATED_VALUES_APP_ID }}', 'private-key': '${{ secrets.GENERATED_VALUES_APP_PRIVATE_KEY }}',
      owner: 'soma-376', repositories: 'infra-generated-values', 'permission-contents': 'write',
    });
    expect(publish.env).toEqual({ GH_TOKEN: '${{ github.token }}', VALUES_GH_TOKEN: '${{ steps.values-token.outputs.token }}' });
    expect(publish.run).toBe('node scripts/dev-generated-values-sync.mjs --directory "$RUNNER_TEMP/dev-cdk-plan"');
    expect(command(job, 'deploy')).toBeUndefined();
    expect(command(job, 'plan')).toBeUndefined();
  });

  test('fixture 검증과 publisher가 동일한 고정 Helm을 사용하고 plugin도 검증된 버전이다', () => {
    const consumers = [pr.jobs.validate, cd.jobs.plan, cd.jobs.publish, inputs.jobs.validate];
    for (const job of consumers) {
      const helm = steps(job).find(step => step.name === '고정 Helm 준비');
      expect(helm.run).toContain('https://get.helm.sh/helm-v3.22.0-linux-amd64.tar.gz');
      expect(helm.run).toContain('1e4ab49e429626cf6c6958d914248b78c9730803c2751b87627e171dc800e7bb');
      expect(helm.run).toContain('sha256sum --check');
      expect(helm.run).toContain('HELM_BIN=');
      if (job !== cd.jobs.publish) {
        const tests = steps(job).find(step => step.run?.startsWith('npm test -- --runInBand'));
        for (const target of valuesTestTargets) expect(tests.run).toContain(target);
        expect(stepIndex(job, helm)).toBeLessThan(stepIndex(job, tests));
      }
    }
    const plugin = steps(cd.jobs.publish).find(step => step.name === '고정 Session Manager plugin 준비');
    expect(plugin.run).toContain('/plugin/1.2.896.0/ubuntu_64bit/session-manager-plugin.deb');
    expect(plugin.run).toContain('53f51fcc67314a4bf85888a38a3967cd41f8d0f28a60a9469a63acf935ba713e');
    expect(plugin.run).toContain('sha256sum --check');
    expect(plugin.run).toContain('test "$(session-manager-plugin --version)" = \'1.2.896.0\'');
    expect(plugin.run).not.toContain('/plugin/latest/');
  });

  test('private 생성물·원문·로그를 artifact에 넣지 않고 초기 실패도 정제 결과만 남긴다', () => {
    const job = cd.jobs.publish;
    const uploads = steps(job).filter(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploads).toHaveLength(1);
    const upload = uploads[0];
    expect(upload.if).toBe('always()');
    expect(upload.with['retention-days']).toBe(14);
    expect(upload.with.path.trim().split('\n')).toEqual([
      '${{ runner.temp }}/dev-cdk-plan/result-publish.json', '${{ runner.temp }}/dev-cdk-plan/result-publish-workflow.json',
    ]);
    expect(upload.with.path).not.toMatch(/\*|\/logs|generated\/|outputs\.json|kubeconfig|metadata\.json/);
    const fallback = steps(job).find(step => step.env?.WORKFLOW_JOB_STATUS);
    expect(fallback.if).toBe('always()');
    expect(stepIndex(job, fallback)).toBeLessThan(stepIndex(job, upload));
    const directory = mkdtempSync(join(tmpdir(), 'dev-values-workflow-'));
    try {
      const summary = join(directory, 'summary.md');
      const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', fallback.run], {
        env: { ...process.env, RUNNER_TEMP: directory, GITHUB_STEP_SUMMARY: summary, WORKFLOW_JOB_STATUS: 'failure' }, encoding: 'utf8',
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(readFileSync(join(directory, 'dev-cdk-plan/result-publish-workflow.json'), 'utf8'))).toEqual({ phase: 'publish', status: 'failure' });
      expect(readFileSync(summary, 'utf8')).toContain('failure');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  test('추가 shell 단계는 bash 문법이 유효하다', () => {
    for (const job of [...jobs, inputs.jobs.validate]) {
      for (const step of steps(job).filter(step => step.run)) {
        const result = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
        expect(result.stderr).toBe('');
        expect(result.status).toBe(0);
      }
    }
  });
});
