import { Template } from 'aws-cdk-lib/assertions';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDevApp } from '../helpers';
const { load } = require('js-yaml');
const { parseRuntimeInputs } = require('../../lib/dev/runtime-input.cjs');

const fixture = () => load(readFileSync(join(__dirname, '../fixtures/eks-runtime.yaml'), 'utf8'));
const version = '11111111-1111-4111-8111-111111111111';
function active() {
  const value = fixture();
  value.userAuth.allowedRedirectUris = ['https://dashboard.example.invalid/auth/callback'];
  value.oidc = { enabled: true, callbackBaseUrl: 'https://auth.example.invalid',
    failureRedirectUri: value.userAuth.allowedRedirectUris[0],
    clients: [{ key: 'cognito-b', versionId: version }, { key: 'cognito-a', versionId: version }] };
  return value;
}
function build(keys: string[]) {
  return buildDevApp({ devOidcClientKeys: keys });
}

describe('EKS OIDC runtime 입력', () => {
  test('추적 dev runtime은 고정 로컬 웹과 기존 HTTPS callback을 함께 보존한다', () => {
    const input = load(readFileSync(join(__dirname, '../../config/dev/runtime.yaml'), 'utf8'));
    const parsed = parseRuntimeInputs(input);
    expect(parsed.userAuth.allowedOrigins).toEqual([
      'https://dev.pulsemetry.co.kr',
      'http://localhost:3000',
    ]);
    expect(parsed.userAuth.allowedRedirectUris).toEqual([
      'http://localhost:3000/auth/callback',
      'https://dev.pulsemetry.co.kr/auth/callback',
    ]);
    expect(parsed.oidc.callbackBaseUrl).toBe('https://api-dev.pulsemetry.co.kr');
    expect(parsed.oidc.failureRedirectUri).toBe('https://dev.pulsemetry.co.kr/auth/callback');
  });
  test('기존 입력은 OIDC 없이 유지하고 활성 입력을 정렬·기본값 처리한다', () => {
    expect(parseRuntimeInputs(fixture()).oidc).toBeUndefined();
    const parsed = parseRuntimeInputs(active());
    expect(parsed.oidc?.callbackRegistrationId).toBe('oidc');
    expect(parsed.oidc?.allowInsecureLocalhost).toBe(false);
    expect(parsed.oidc?.clients.map((c: any) => c.key)).toEqual(['cognito-a', 'cognito-b']);
    expect(parsed.userAuth.publicKeys).toEqual(parseRuntimeInputs(fixture()).userAuth.publicKeys);
  });
  test.each(['http', 'https'])('%s callback·복귀 주소를 정규화하며 localhost 예외를 자동 활성화하지 않는다', scheme => {
    const value = active();
    value.oidc.callbackBaseUrl = `${scheme}://validation-alb.example.invalid:8080`;
    value.oidc.failureRedirectUri = `${scheme}://dashboard.example.invalid:3000/auth/callback`;
    value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri];
    const parsed = parseRuntimeInputs(value);
    expect(parsed.oidc.callbackBaseUrl).toBe(value.oidc.callbackBaseUrl);
    expect(parsed.oidc.failureRedirectUri).toBe(value.oidc.failureRedirectUri);
    expect(parsed.userAuth.allowedRedirectUris).toEqual([value.oidc.failureRedirectUri]);
    expect(parsed.oidc.allowInsecureLocalhost).toBe(false);
  });
  test.each([undefined, false, true])('localhost 허용 입력 %j를 boolean으로 유지한다', flag => {
    const value = active();
    value.oidc.callbackBaseUrl = 'http://localhost:8080';
    value.oidc.failureRedirectUri = 'http://localhost:3000/auth/callback';
    value.userAuth.allowedRedirectUris = [value.oidc.failureRedirectUri];
    if (flag !== undefined) value.oidc.allowInsecureLocalhost = flag;
    const parsed = parseRuntimeInputs(value);
    expect(parsed.oidc?.allowInsecureLocalhost).toBe(flag ?? false);
  });
  test.each(['true', 'false', 0, 1, null, [], {}])('localhost 허용 입력의 잘못된 타입 %j를 활성·비활성 모두 거부한다', flag => {
    for (const enabled of [true, false]) {
      const value = active();
      value.oidc.enabled = enabled;
      value.oidc.allowInsecureLocalhost = flag;
      expect(() => parseRuntimeInputs(value)).toThrow('oidc.allowInsecureLocalhost');
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
    expect(() => parseRuntimeInputs(value)).toThrow('runtime 입력 오류');
    try { parseRuntimeInputs(value); } catch (error) { expect(String(error)).not.toContain('sensitive-marker'); }
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
    expect(() => parseRuntimeInputs(value)).toThrow('runtime 입력 오류');
    const callback = active(); callback.oidc.callbackBaseUrl = uri;
    expect(() => parseRuntimeInputs(callback)).toThrow('runtime 입력 오류');
  });
});

describe('빈 원본 bootstrap과 소비자 권한', () => {
  const enabled = build(['cognito-b', 'cognito-a']);
  const data = Template.fromStack(enabled.data).toJSON();
  const eks = Template.fromStack(enabled.eks).toJSON();
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
    const after = Template.fromStack(build(['Cognito_C', 'cognito-a', 'cognito-b']).data).toJSON();
    for (const [id, source] of Object.entries(sources)) expect(after.Resources[id]).toEqual(source);
  });
  test('enrollment Pod Identity만 선언 원본을 읽으며 다른 역할은 접근하지 못한다', () => {
    const associations = Object.values(eks.Resources).filter((r: any) =>
      r.Type === 'AWS::EKS::PodIdentityAssociation' && r.Properties.ServiceAccount === 'enrollment-api') as any[];
    expect(associations).toHaveLength(1);
    expect(associations[0].Properties.Namespace).toBe('pulsemetry-dev');
    const enrollmentRole = associations[0].Properties.RoleArn['Fn::GetAtt'][0];
    let enrollmentPolicies = 0;
    for (const [id, policy] of Object.entries(eks.Resources) as [string, any][]) {
      if (policy.Type !== 'AWS::IAM::Policy') continue;
      if (policy.Properties.Roles.some((role: any) => role.Ref === enrollmentRole)) {
        enrollmentPolicies++;
        const read = policy.Properties.PolicyDocument.Statement.find((statement: any) =>
          statement.Action.includes('secretsmanager:GetSecretValue'));
        expect(read.Action).toEqual(['secretsmanager:DescribeSecret', 'secretsmanager:GetSecretValue']);
        expect(read.Condition).toEqual({ Bool: { 'aws:SecureTransport': 'true' } });
        expect(read.Resource).toHaveLength(11);
        for (const key of ['cognitoa', 'cognitob']) expect(JSON.stringify(read.Resource)).toContain(`DevOidcClientSecret${key}`);
      } else {
        expect(JSON.stringify(policy)).not.toContain('OidcClientSecret');
      }
    }
    expect(enrollmentPolicies).toBe(1);
  });
  test('CDK key 선언은 runtime 활성 여부·버전 입력 없이 빈 원본과 EKS 권한을 준비한다', () => {
    const value = fixture(); value.oidc = { enabled: false, allowInsecureLocalhost: true, clients: [{ key: 'cognito-a' }] };
    expect(parseRuntimeInputs(value).oidc.enabled).toBe(false);
    const stacks = build(['cognito-a']);
    expect(JSON.stringify(Template.fromStack(stacks.data).toJSON())).toContain('soma-376/dev/oidc/clients/cognito-a');
    expect(JSON.stringify(Template.fromStack(stacks.eks).toJSON())).toContain('OidcClientSecret');
    expect(Template.fromStack(build([]).data).findOutputs('OidcClientSecretArns')).toEqual({});
  });
});
