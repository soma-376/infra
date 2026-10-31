import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildPerfApp } from '../helpers';

test('직렬화한 cloud assembly의 스택 태그를 CFN 조회로 전달하면 정리 관측은 WAITING이다', () => {
  const environmentId = 'perf-unit-cleanup';
  const { app } = buildPerfApp({ perfEnvironmentId: environmentId, perfProfile: 'profiles/perf/strimzi-fixed-v1.json',
    perfCertificateArn: 'arn:aws:acm:ap-northeast-2:111111111111:certificate/01234567-0123-0123-0123-0123456789ab' });
  expect(app.node.tryGetContext('@aws-cdk/core:explicitStackTags')).toBe(true);
  const assembly = app.synth();
  const manifest = JSON.parse(readFileSync(join(assembly.directory, 'manifest.json'), 'utf8'));
  const stackTags = Object.fromEntries(Object.entries(manifest.artifacts).filter(([, value]: [string, any]) => value.type === 'aws:cloudformation:stack')
    .map(([name, value]: [string, any]) => [name, value.properties.tags ?? {}]));
  expect(Object.keys(stackTags)).toHaveLength(6);
  for (const tags of Object.values(stackTags)) expect(tags).toEqual({ Org: 'soma-376', Env: 'perf', ManagedBy: 'cdk', 'pulsemetry:perf-environment': environmentId });
  // fixture에서 소유 태그를 만들어 넣지 않고 실제 manifest를 DescribeStacks의 Key/Value로 바꾼다.
  const program = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('cleanup_tests','scripts/test-perf-cleanup.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
tags=json.load(sys.stdin)
stacks={name:m.stack(name,Tags=[{'Key':k,'Value':v} for k,v in values.items()]) for name,values in tags.items()}
c,a=m.CleanupTests().setup_cleaner(stacks=stacks)
r=c.tick()
assert r['phase']=='WAITING',r
assert not a['cloudformation'].delete_stack.called
assert not a['ssm'].send_command.called
stacks['PerfGuardrailStack']['Tags']=[]
c,a=m.CleanupTests().setup_cleaner(stacks=stacks)
assert c.tick()['error']=='ownership_mismatch:PerfGuardrailStack'
print('assembly-tags -> CFN -> WAITING; missing tags -> ERROR')`;
  const result = spawnSync('python3', ['-c', program], { cwd: resolve(__dirname, '../..'), input: JSON.stringify(stackTags), encoding: 'utf8' });
  expect([result.status, result.stderr]).toEqual([0, '']);
  expect(result.stdout).toContain('assembly-tags -> CFN -> WAITING; missing tags -> ERROR');
});
