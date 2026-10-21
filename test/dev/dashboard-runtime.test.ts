import { App, Stack } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { Ec2TaskDefinition, ContainerImage, NetworkMode } from 'aws-cdk-lib/aws-ecs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDashboardRuntimeConfig, parseDashboardRuntimeConfig, userAuthEnvironment } from '../../lib/dev/dashboard-runtime-config';
import { attachUserJwtKeyWriter, dashboardEcsSettings } from '../../lib/dev/ecs-dashboard-runtime';
import { buildDevApp, TEST_ENV } from '../helpers';

const fixture = () => JSON.parse(readFileSync(join(__dirname, '../fixtures/dashboard-runtime.json'), 'utf8'));

describe('명시적 dashboard runtime 입력', () => {
  test('dev 입력 누락을 실패로 처리한다', () => {
    expect(() => loadDashboardRuntimeConfig(new App())).toThrow('devDashboardRuntimeFile');
    expect(() => buildDevApp({ devDashboardRuntimeFile: undefined })).toThrow('devDashboardRuntimeFile');
  });
  test.each([
    (v: any) => { delete v.writerImage; },
    (v: any) => { v.writerImage = v.writerImage.replace(/@sha256:.*/, ':latest'); },
    (v: any) => { v.userAuth.publicVersionId = 'AWSCURRENT'; },
    (v: any) => { v.userAuth.publicKeys[0].alias = '../escape.pem'; },
    (v: any) => { v.userAuth.publicKeys[0].alias = 'private.pem'; },
    (v: any) => { v.userAuth.publicKeys.push(v.userAuth.publicKeys[0]); },
    (v: any) => { v.userAuth.activeKid = 'missing'; },
    (v: any) => { v.userAuth.privatePem = 'sensitive-marker'; },
    (v: any) => { v.userAuth.allowedOrigins = ['*']; },
    (v: any) => { v.userAuth.allowedOrigins = ['https://example.invalid/path']; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DB_PASSWORD = 'sensitive-marker'; },
    (v: any) => { delete v.dashboard.settings.PULSEMETRY_DASHBOARD_SNAPSHOT_BUILD_TIMEOUT; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_INGEST_DOWN_AFTER = '1s'; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '1.5s'; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_SNAPSHOT_MAX_CONCURRENT_BUILDS = '2147483648'; },
    (v: any) => { v.dashboard.managementEnabled = true; },
    (v: any) => { v.dashboard.mailEnabled = true; },
    (v: any) => { v.userAuth.publicKeys[0].alias = 'a'.repeat(97) + '.pem'; },
    (v: any) => { v.userAuth.allowedOrigins = ['https://a,b.example.invalid']; },
    (v: any) => { v.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '999999999999999999999s'; },
  ])('잘못된 값과 원문 공급을 차단한다 #%#', change => {
    const value = fixture(); change(value);
    expect(() => parseDashboardRuntimeConfig(value)).toThrow('runtime 입력 오류');
    try { parseDashboardRuntimeConfig(value); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
  });
  test('정수 밀리초를 부동소수점 반올림 없이 허용한다', () => {
    const input = fixture(); input.dashboard.settings.PULSEMETRY_DASHBOARD_RETRY_AFTER = '1001ms';
    expect(() => parseDashboardRuntimeConfig(input)).not.toThrow();
  });
  test('임의 kid는 구조화된 Spring map으로 보존하고 signer만 개인키 경로를 가진다', () => {
    const input = fixture(); input.userAuth.activeKid = 'Key.Release/2026'; input.userAuth.publicKeys[0].kid = input.userAuth.activeKid;
    const config = parseDashboardRuntimeConfig(input);
    const verifier = userAuthEnvironment(config, false);
    expect(JSON.parse(verifier.SPRING_APPLICATION_JSON).pulsemetry['user-auth']['public-key-files']).toEqual({ '[Key.Release/2026]': '/mnt/user-jwt/keys/release-2026-10.pem' });
    expect(verifier.PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE).toBeUndefined();
    expect(userAuthEnvironment(config, true).PULSEMETRY_USER_AUTH_PRIVATE_KEY_FILE).toBe('/mnt/user-jwt/keys/private.pem');
  });
});

describe('ECS runtime 권한과 기동 순서', () => {
  const { application } = buildDevApp();
  const template = Template.fromStack(application).toJSON();
  const tasks: any[] = Object.values(template.Resources).filter((r: any) => r.Type === 'AWS::ECS::TaskDefinition');
  const enrollment = tasks.find(t => t.Properties.ContainerDefinitions.some((c: any) => c.Name === 'enrollment-api')).Properties;
  const containers = enrollment.ContainerDefinitions;
  const writer = containers.find((c: any) => c.Name === 'jwt-key-writer');
  const app = containers.find((c: any) => c.Name === 'enrollment-api');
  function policyFor(role: any) {
    return Object.values(template.Resources).filter((r: any) => r.Type === 'AWS::IAM::Policy' && JSON.stringify(r.Properties.Roles).includes(role.Ref)).map((r: any) => r.Properties.PolicyDocument.Statement).flat();
  }
  test('writer 성공 후에만 UID10001 앱이 읽기 전용 task volume을 소비한다', () => {
    expect(enrollment.Volumes).toEqual([{ Name: 'user-jwt' }]);
    expect(writer).toMatchObject({ Essential: false, StartTimeout: 60, MemoryReservation: 64, Memory: 128, ReadonlyRootFilesystem: true, User: '0:0' });
    expect(app.User).toBe('10001:10001');
    expect(app.DependsOn).toEqual([{ ContainerName: 'jwt-key-writer', Condition: 'SUCCESS' }]);
    expect(app.MountPoints).toEqual([{ SourceVolume: 'user-jwt', ContainerPath: '/mnt/user-jwt', ReadOnly: true }]);
    expect(writer.MountPoints).toEqual([{ SourceVolume: 'user-jwt', ContainerPath: '/mnt/user-jwt', ReadOnly: false }]);
    expect(JSON.stringify(writer.Image)).toContain('@sha256:');
    const settings = JSON.stringify(writer.Environment);
    expect(settings).toContain(fixture().userAuth.privateVersionId);
    expect(settings).toContain(fixture().userAuth.publicVersionId);
    expect(settings).not.toMatch(/AWSCURRENT|VersionStage/);
  });
  test('JWT 조회는 enrollment task role에만, DB 주입은 execution role에 둔다', () => {
    const roleRef = { Ref: enrollment.TaskRoleArn['Fn::GetAtt'][0] };
    const executionRef = { Ref: enrollment.ExecutionRoleArn['Fn::GetAtt'][0] };
    const taskPolicy = JSON.stringify(policyFor(roleRef));
    expect(taskPolicy).toContain('secretsmanager:GetSecretValue');
    expect(taskPolicy).toContain('UserJwtPublicKeys');
    expect(taskPolicy).toContain('UserJwtPrivateKey');
    expect(JSON.stringify(policyFor(executionRef))).not.toMatch(/UserJwtPublicKeys|UserJwtPrivateKey/);
    const ingest = tasks.find(t => t.Properties.ContainerDefinitions.some((c: any) => c.Name === 'telemetry-ingest')).Properties;
    expect(ingest.ContainerDefinitions).toHaveLength(1);
    expect(JSON.stringify(policyFor({ Ref: ingest.TaskRoleArn['Fn::GetAtt'][0] }))).not.toMatch(/secretsmanager|UserJwt/);
  });
  test('dashboard helper는 전용 네 연결만 주입하고 공개키만 조회한다', () => {
    const stack = new Stack(new App(), 'DashboardFixture', { env: TEST_ENV });
    const secrets = Object.fromEntries(['rdsSource', 'rdsCache', 'clickhouseSource', 'clickhouseCache'].map(name => [name, new Secret(stack, name)])) as any;
    const task = new Ec2TaskDefinition(stack, 'Task', { networkMode: NetworkMode.BRIDGE });
    const app = task.addContainer('dashboard-api', { image: ContainerImage.fromRegistry('fixture'), memoryReservationMiB: 1024, ...dashboardEcsSettings(parseDashboardRuntimeConfig(fixture()), 'db.example.invalid', 'http://clickhouse.obs.local:8123', secrets) });
    attachUserJwtKeyWriter(task, app, parseDashboardRuntimeConfig(fixture()), new Secret(stack, 'PublicKeys'));
    const json = Template.fromStack(stack).toJSON();
    const def: any = Object.values(json.Resources).find((r: any) => r.Type === 'AWS::ECS::TaskDefinition');
    const dashboard = def.Properties.ContainerDefinitions.find((c: any) => c.Name === 'dashboard-api');
    expect(dashboard.Secrets).toHaveLength(8);
    expect(JSON.stringify(dashboard)).not.toMatch(/TOKEN_HASH|ADMIN_API_TOKEN|RAW_BUCKET|PRIVATE_KEY/);
    expect(JSON.stringify(def)).not.toContain('privateVersionId');
    const policies = JSON.stringify(Object.values(json.Resources).filter((r: any) => r.Type === 'AWS::IAM::Policy'));
    expect(policies).not.toContain('s3:');
  });
});
