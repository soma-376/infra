#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pipeline from './dev-cdk-pipeline.cjs';
import { collectBackendImageInputs, validateBackendImageInputs } from './backend-image-inputs.mjs';

// 실제 AWS 실행은 보호된 workflow에서만 한다. 로컬 테스트는 runner를 주입한다.
const [operation, flag, directory, ...extra] = process.argv.slice(2);
if (!['plan', 'verify', 'deploy', 'verify-publish'].includes(operation) || flag !== '--directory' || !directory || extra.length) {
  console.error('사용법: node scripts/dev-cdk-pipeline.mjs plan|verify|deploy|verify-publish --directory <path>');
  process.exitCode = 1;
} else {
  try {
    const enabled = operation === 'plan' && ['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) && process.env.GENERATED_VALUES_SYNC_ENABLED === 'true';
    const generatedValues = enabled ? { enabled: true, backend: await collectBackendImageInputs({}) } : { enabled: false };
    pipeline.createPipeline({ root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), directory,
      generatedValues, validateImages: validateBackendImageInputs }).execute(operation);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
