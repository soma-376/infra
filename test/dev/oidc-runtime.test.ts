import { Template } from 'aws-cdk-lib/assertions';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDevApp } from '../helpers';
import { parseDashboardRuntimeConfig, userAuthEnvironment } from '../../lib/dev/dashboard-runtime-config';

const directory = mkdtempSync(join(tmpdir(), 'oidc-runtime-test-'));
let sequence = 0;
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const fixture = () => JSON.parse(readFileSync(join(__dirname, '../fixtures/dashboard-runtime.json'), 'utf8'));
const version = '11111111-1111-4111-8111-111111111111';
function active() {
  const value = fixture();
  value.userAuth.allowedRedirectUris = ['https://dashboard.example.invalid/auth/callback'];
  value.oidc = { enabled: true, callbackBaseUrl: 'https://auth.example.invalid',
    failureRedirectUri: value.userAuth.allowedRedirectUris[0],
    clients: [{ key: 'cognito-b', versionId: version }, { key: 'cognito-a', versionId: version }] };
  return value;
}
function build(value: any) {
  const filename = join(directory, `runtime-${sequence++}.json`);
  writeFileSync(filename, JSON.stringify(value));
  return buildDevApp({ devDashboardRuntimeFile: filename, devEksEnabled: true });
}
function appTask(template: any, name: string) {
  return (Object.values(template.Resources) as any[]).find(r => r.Type === 'AWS::ECS::TaskDefinition' &&
    r.Properties.ContainerDefinitions.some((c: any) => c.Name === name)).Properties;
}
function policyFor(template: any, role: any) {
  return (Object.values(template.Resources) as any[]).filter(r => r.Type === 'AWS::IAM::Policy' &&
    r.Properties.Roles.some((entry: any) => entry.Ref === role['Fn::GetAtt'][0])).flatMap(r => r.Properties.PolicyDocument.Statement);
}

describe('OIDC 입력과 Spring 설정 맵', () => {
  test('기존 입력은 OIDC 없이 유지하고 활성 입력을 정렬·기본값 처리한다', () => {
    expect(parseDashboardRuntimeConfig(fixture()).oidc).toBeUndefined();
    const parsed = parseDashboardRuntimeConfig(active());
    expect(parsed.oidc?.callbackRegistrationId).toBe('oidc');
    expect(parsed.oidc?.allowInsecureLocalhost).toBe(false);
    expect(parsed.oidc?.clients.map(c => c.key)).toEqual(['cognito-a', 'cognito-b']);
    const env = userAuthEnvironment(parsed, true);
    const json = JSON.parse(env.SPRING_APPLICATION_JSON).pulsemetry;
    expect(json.oidc).toEqual({ 'callback-registration-id': 'oidc', 'allow-insecure-localhost': false, 'client-secrets': {
      '[cognito-a]': '${PULSEMETRY_OIDC_CLIENT_SECRET_0}', '[cognito-b]': '${PULSEMETRY_OIDC_CLIENT_SECRET_1}',
    } });
    expect(json['user-auth']['public-key-files']).toEqual(JSON.parse(userAuthEnvironment(parseDashboardRuntimeConfig(fixture()), true).SPRING_APPLICATION_JSON).pulsemetry['user-auth']['public-key-files']);
    expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe(parsed.userAuth.allowedRedirectUris![0]);
    const verifier = userAuthEnvironment(parsed, false);
    expect(JSON.stringify(verifier)).not.toMatch(/OIDC|client-secrets|allowed-redirect|ALLOWED_REDIRECT/);
  });
  test.each(['http', 'https'])('%s callback·복귀 주소를 ECS 설정에 그대로 전달한다', scheme => {
    const value = active();
    value.oidc.callbackBaseUrl = `${scheme}://validation-alb.example.invalid:8080`;
    value.oidc.failureRedirectUri = `${scheme}://dashboard.example.invalid:3000/auth/callback`;
    value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri];
    const parsed = parseDashboardRuntimeConfig(value);
    const env = userAuthEnvironment(parsed, true);
    expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBe(value.oidc.callbackBaseUrl);
    expect(env.PULSEMETRY_OIDC_FAILURE_REDIRECT_URI).toBe(value.oidc.failureRedirectUri);
    expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe(value.oidc.failureRedirectUri);
    expect(JSON.parse(env.SPRING_APPLICATION_JSON).pulsemetry.oidc['allow-insecure-localhost']).toBe(false);
  });
  test.each([undefined, false, true])('localhost 허용 입력 %j를 enrollment ECS task에 boolean으로 전달한다', flag => {
    const value = active();
    value.oidc.callbackBaseUrl = 'http://localhost:8080';
    value.oidc.failureRedirectUri = 'http://localhost:3000/auth/callback';
    value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri];
    if (flag !== undefined) value.oidc.allowInsecureLocalhost = flag;
    const parsed = parseDashboardRuntimeConfig(value);
    expect(parsed.oidc?.allowInsecureLocalhost).toBe(flag ?? false);
    const template = Template.fromStack(build(value).application).toJSON();
    const task = appTask(template, 'enrollment-api');
    const app = task.ContainerDefinitions.find((c: any) => c.Name === 'enrollment-api');
    const env = Object.fromEntries(app.Environment.map((entry: any) => [entry.Name, entry.Value]));
    const properties = JSON.parse(env.SPRING_APPLICATION_JSON).pulsemetry;
    expect(properties.oidc['allow-insecure-localhost']).toBe(flag ?? false);
    expect(properties.oidc['client-secrets']['[cognito-a]']).toBe('${PULSEMETRY_OIDC_CLIENT_SECRET_0}');
    expect(properties['user-auth']['public-key-files']).toEqual(
      JSON.parse(userAuthEnvironment(parsed, true).SPRING_APPLICATION_JSON).pulsemetry['user-auth']['public-key-files'],
    );
    expect(env.PULSEMETRY_OIDC_CALLBACK_BASE_URL).toBe(value.oidc.callbackBaseUrl);
    expect(env.PULSEMETRY_OIDC_FAILURE_REDIRECT_URI).toBe(value.oidc.failureRedirectUri);
    expect(env.PULSEMETRY_USER_AUTH_ALLOWED_REDIRECT_URIS).toBe(value.oidc.failureRedirectUri);
    for (const name of ['dashboard-api', 'telemetry-ingest']) {
      expect(JSON.stringify(appTask(template, name))).not.toMatch(/allow-insecure-localhost|ALLOW_INSECURE_LOCALHOST/);
    }
  });
  test.each(['true', 'false', 0, 1, null, [], {}])('localhost 허용 입력의 잘못된 타입 %j를 활성·비활성 모두 거부한다', flag => {
    for (const enabled of [true, false]) {
      const value = active();
      value.oidc.enabled = enabled;
      value.oidc.allowInsecureLocalhost = flag;
      expect(() => parseDashboardRuntimeConfig(value)).toThrow('oidc.allowInsecureLocalhost');
    }
  });
  test.each([
    (v: any) => { v.oidc.enabled = 'true'; },
    (v: any) => { v.oidc.clients = []; },
    (v: any) => { v.oidc.clients.push(v.oidc.clients[0]); },
    (v: any) => { v.oidc.clients[0].key = '../escape'; },
    (v: any) => { v.oidc.clients[0].key = 123; },
    (v: any) => { v.oidc.clients[0].key = 'a'.repeat(65); },
    (v: any) => { delete v.oidc.clients[0].versionId; },
    (v: any) => { v.oidc.clients[0].versionId = 'AWSCURRENT'; },
    (v: any) => { v.oidc.clients[0].secretArn = 'sensitive-marker'; },
    (v: any) => { v.oidc.clients[0].secret = 'sensitive-marker'; },
    (v: any) => { v.oidc.clientSecrets = { key: 'sensitive-marker' }; },
    (v: any) => { v.oidc.callbackBaseUrl = 'ftp://auth.example.invalid'; },
    (v: any) => { v.oidc.callbackBaseUrl = 'https://auth.example.invalid/path'; },
    (v: any) => { v.oidc.callbackBaseUrl = 'https://user:password@auth.example.invalid'; },
    (v: any) => { v.oidc.callbackRegistrationId = 'oidc/path'; },
    (v: any) => { v.oidc.failureRedirectUri = 'https://wrong.example.invalid'; },
    (v: any) => { delete v.userAuth.allowedRedirectUris; },
    (v: any) => { v.userAuth.allowedRedirectUris = ['ftp://dashboard.example.invalid']; },
    (v: any) => { v.userAuth.allowedRedirectUris.push(v.userAuth.allowedRedirectUris[0]); },
    (v: any) => { v.userAuth.allowedRedirectUris = ['https://dashboard.example.invalid/#fragment']; },
  ])('잘못된 입력·비밀·ARN override를 비밀 없는 오류로 거부한다 #%#', mutate => {
    const value = active(); mutate(value);
    expect(() => parseDashboardRuntimeConfig(value)).toThrow('runtime 입력 오류');
    try { parseDashboardRuntimeConfig(value); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
  });
  test.each([
    'https://dashboard.example.invalid/auth/callback?source=cognito',
    'https://dashboard.example.invalid/auth/callback?',
    'https://dashboard.example.invalid/auth/callback#',
    'https://dashboard.example.invalid/auth/call back',
    'https://dashboard.example.invalid/auth/call\\back',
    'https://dashboard.example.invalid/auth/%invalid',
    'https://dashboard.example.invalid/auth/[callback]',
    'https://@dashboard.example.invalid/auth/callback',
    'https://dash_board.example.invalid/auth/callback',
    'https://auth..example.invalid',
    'https://auth.-example.invalid',
    'https://auth.example-.invalid',
    'https://dashboard.example.invalid/' + 'a'.repeat(256),
  ])('backend에서 거부하는 복귀 URL을 배포 전에 차단한다 #%#', uri => {
    const value = active();
    value.userAuth.allowedRedirectUris = [uri]; value.oidc.failureRedirectUri = uri;
    expect(() => parseDashboardRuntimeConfig(value)).toThrow('runtime 입력 오류');
    const callback = active(); callback.oidc.callbackBaseUrl = uri;
    expect(() => parseDashboardRuntimeConfig(callback)).toThrow('runtime 입력 오류');
  });
});

describe('빈 원본 bootstrap과 소비자 권한', () => {
  const input = active();
  const enabled = build(input);
  const data = Template.fromStack(enabled.data).toJSON();
  const ecs = Template.fromStack(enabled.application).toJSON();
  const eks = Template.fromStack(enabled.eks!).toJSON();
  const enrollment = appTask(ecs, 'enrollment-api');
  const app = enrollment.ContainerDefinitions.find((c: any) => c.Name === 'enrollment-api');
  const sources = Object.fromEntries(Object.entries(data.Resources).filter(([, r]: any) =>
    r.Type === 'AWS::SecretsManager::Secret' && r.Properties.Name?.startsWith('soma-376/dev/oidc/clients/')));

  test('값·생성기·CMK 없는 보존 원본과 DataStack output을 만든다', () => {
    expect(Object.keys(sources)).toHaveLength(2);
    for (const source of Object.values(sources) as any[]) {
      expect(source.DeletionPolicy).toBe('Retain');
      expect(source.UpdateReplacePolicy).toBe('Retain');
      expect(source.Properties.SecretString).toBeUndefined();
      expect(source.Properties.GenerateSecretString).toBeUndefined();
      expect(source.Properties.KmsKeyId).toBeUndefined();
    }
    expect(JSON.stringify(data.Outputs.OidcClientSecretArns)).toContain('cognito-a');
    const baseline = Template.fromStack(buildDevApp().data).toJSON();
    for (const [id, resource] of Object.entries(baseline.Resources)) expect(data.Resources[id]).toEqual(resource);
  });
  test('재정렬·다른 client 추가가 기존 logical ID와 속성을 바꾸지 않는다', () => {
    const changed = active(); changed.oidc.clients.reverse();
    changed.oidc.clients.unshift({ key: 'Cognito_C', versionId: version });
    const after = Template.fromStack(build(changed).data).toJSON();
    for (const [id, source] of Object.entries(sources)) expect(after.Resources[id]).toEqual(source);
  });
  test('enrollment execution role만 고정 버전의 값을 주입하고 JWT writer는 보존한다', () => {
    const injected = app.Secrets.filter((s: any) => s.Name.startsWith('PULSEMETRY_OIDC_'));
    expect(injected.map((s: any) => s.Name)).toEqual(['PULSEMETRY_OIDC_CLIENT_SECRET_0', 'PULSEMETRY_OIDC_CLIENT_SECRET_1']);
    for (const item of injected) expect(JSON.stringify(item.ValueFrom)).toContain(':::' + version);
    expect(JSON.stringify(policyFor(ecs, enrollment.ExecutionRoleArn))).toContain('OidcClientSecret');
    expect(JSON.stringify(policyFor(ecs, enrollment.TaskRoleArn))).not.toContain('OidcClientSecret');
    for (const name of ['dashboard-api', 'telemetry-ingest']) {
      const task = appTask(ecs, name);
      expect(JSON.stringify(task)).not.toMatch(/OIDC|OidcClientSecret|client-secrets/);
      expect(JSON.stringify(policyFor(ecs, task.ExecutionRoleArn))).not.toContain('OidcClientSecret');
      expect(JSON.stringify(policyFor(ecs, task.TaskRoleArn))).not.toContain('OidcClientSecret');
    }
    const before = appTask(Template.fromStack(buildDevApp().application).toJSON(), 'enrollment-api');
    expect(enrollment.ContainerDefinitions.find((c: any) => c.Name === 'jwt-key-writer')).toEqual(before.ContainerDefinitions.find((c: any) => c.Name === 'jwt-key-writer'));
    expect(enrollment.Volumes).toEqual(before.Volumes);
  });
  test('EKS는 enrollment에만 선언 원본을 허용한다', () => {
    for (const [id, policy] of Object.entries(eks.Resources) as [string, any][]) {
      if (policy.Type !== 'AWS::IAM::Policy') continue;
      if (id.includes('RuntimeEnrollment')) expect(JSON.stringify(policy)).toContain('OidcClientSecret');
      else expect(JSON.stringify(policy)).not.toContain('OidcClientSecret');
    }
  });
  test('disabled key 목록은 빈 원본만 준비하고 ECS 조회 없이 EKS 독립 활성화를 허용한다', () => {
    const value = fixture(); value.oidc = { enabled: false, allowInsecureLocalhost: true, clients: [{ key: 'cognito-a' }] };
    const stacks = build(value);
    const off = Template.fromStack(stacks.application).toJSON();
    const baseline = Template.fromStack(buildDevApp().application).toJSON();
    expect(off).toEqual(baseline);
    expect(JSON.stringify(Template.fromStack(stacks.data).toJSON())).toContain('soma-376/dev/oidc/clients/cognito-a');
    expect(JSON.stringify(Template.fromStack(stacks.eks!).toJSON())).toContain('OidcClientSecret');
  });
});
