import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { load, JSON_SCHEMA } from 'js-yaml';
import { hasSecretLiteral } from './contract/bundle';
import { JsonValue, Schemas, environmentSchemas, parseJsonBytes } from './contract/schema-subset';
import { PERF_MSK } from './config';

/**
 * perf 생성기·결과 파일 생산자의 입력 검사. AWS·Kubernetes를 호출하지 않는다. 운영자가 조회한 JSON만 받는다.
 * 비밀 원문은 받지 않는다. 입력에 비밀 모양 문자열이 있으면 거부한다.
 */

/** load-tests v2 공유 사본. `tools/contract.py export-shared`로만 갱신한다(ADR-0050). */
export const PERF_CONTRACT_SCHEMAS = resolve(__dirname, '../../test/fixtures/perf-contract-v2/schemas');

export class PerfInputError extends Error {}

export function fail(message: string): never {
  throw new PerfInputError(message);
}

export type JsonObject = { [key: string]: JsonValue };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 중복 키 없는 JSON 하나. 비밀 모양 문자열이 있으면 원문을 출력하지 않고 거부한다. */
export function parseInputJson(bytes: Uint8Array, label: string): JsonValue {
  let value: JsonValue;
  try {
    value = parseJsonBytes(bytes, label);
  } catch {
    fail(`${label}: 중복 키 없는 UTF-8 JSON이 필요하다`);
  }
  if (hasSecretLiteral(value)) fail(`${label}: 비밀 원문 모양의 값이 있다. 참조만 넣는다`);
  return value;
}

export function parseInputYaml(text: string, label: string): JsonValue {
  let value: unknown;
  try {
    value = load(text, { schema: JSON_SCHEMA });
  } catch {
    fail(`${label}: 중복 키 없는 단일 YAML 문서가 필요하다`);
  }
  if (hasSecretLiteral(value as JsonValue)) fail(`${label}: 비밀 원문 모양의 값이 있다. 참조만 넣는다`);
  return value as JsonValue;
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface DeployedStack {
  readonly name: string;
  readonly arn: string | null;
  readonly status: string | null;
}

export interface PerfOutputs {
  readonly values: Readonly<Record<string, string>>;
  readonly stacks: readonly DeployedStack[];
}

const PERF_STACK_NAMES = ['PerfEvidenceStack', 'PerfNetworkStack', 'PerfDataStack', 'PerfEksStack', 'PerfEdgeStack'];

/**
 * `cdk deploy --outputs-file` 또는 `aws cloudformation describe-stacks` 결과를 합친다. 같은 key의 값이 다르면 거부한다.
 * describe-stacks는 stack ARN·상태도 준다. 결과 파일 생산자는 describe-stacks를 요구한다.
 */
export function collectPerfOutputs(documents: readonly JsonValue[]): PerfOutputs {
  const values: Record<string, string> = {};
  const stacks = new Map<string, DeployedStack>();
  const add = (key: string, value: JsonValue | undefined) => {
    if (typeof value !== 'string' || !value.trim() || /[\r\n\u0000]/.test(value) || /\$\{Token\[/.test(value)) {
      fail(`${key}: 배포된 output의 비어 있지 않은 문자열이 필요하다`);
    }
    if (values[key] !== undefined && values[key] !== value) fail(`${key}: output 값이 충돌한다`);
    values[key] = value;
  };
  for (const document of documents) {
    if (!isObject(document)) fail('outputs: JSON object가 필요하다');
    if (Array.isArray(document.Stacks)) {
      for (const stack of document.Stacks) {
        if (!isObject(stack) || typeof stack.StackName !== 'string') fail('describe-stacks: StackName이 필요하다');
        if (!PERF_STACK_NAMES.includes(stack.StackName)) fail(`describe-stacks: perf 스택이 아니다: ${stack.StackName}`);
        const arn = typeof stack.StackId === 'string' ? stack.StackId : null;
        if (arn !== null && !new RegExp(`^arn:aws:cloudformation:ap-northeast-2:[0-9]{12}:stack/${stack.StackName}/[0-9a-f-]{36}$`).test(arn)) {
          fail(`describe-stacks: ${stack.StackName}의 StackId가 올바르지 않다`);
        }
        stacks.set(stack.StackName, { name: stack.StackName, arn, status: typeof stack.StackStatus === 'string' ? stack.StackStatus : null });
        for (const output of Array.isArray(stack.Outputs) ? stack.Outputs : []) {
          if (!isObject(output) || typeof output.OutputKey !== 'string') fail('describe-stacks: OutputKey가 필요하다');
          add(output.OutputKey, output.OutputValue);
        }
      }
    } else {
      for (const [stackName, outputs] of Object.entries(document)) {
        if (!PERF_STACK_NAMES.includes(stackName) || !isObject(outputs)) fail(`outputs-file: perf 스택 output이 아니다: ${stackName}`);
        if (!stacks.has(stackName)) stacks.set(stackName, { name: stackName, arn: null, status: null });
        for (const [key, value] of Object.entries(outputs)) add(key, value);
      }
    }
  }
  return { values, stacks: PERF_STACK_NAMES.filter(name => stacks.has(name)).map(name => stacks.get(name)!) };
}

/** 필요한 output을 형식과 함께 읽는다. */
export function requiredOutput(outputs: PerfOutputs, key: string, pattern?: RegExp): string {
  const value = outputs.values[key];
  if (value === undefined) fail(`${key}: 배포 output이 없다`);
  if (pattern && !pattern.test(value)) fail(`${key}: 형식이 올바르지 않다`);
  return value;
}

/**
 * `aws kafka get-bootstrap-brokers` 결과. SASL/IAM 주소만 허용하고 public·평문·TLS 주소가 섞이면 거부한다.
 * 주소는 API가 준 그대로 쓰며 cluster 이름으로 호스트를 추정하지 않는다(scripts/eks-values.mjs와 같은 규칙).
 */
export function parsePerfMskBootstrap(value: JsonValue): string {
  if (!isObject(value)) fail('msk-bootstrap: JSON object가 필요하다');
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'BootstrapBrokerStringSaslIam' || typeof value.BootstrapBrokerStringSaslIam !== 'string') {
    fail('msk-bootstrap: BootstrapBrokerStringSaslIam만 허용한다');
  }
  const brokers = value.BootstrapBrokerStringSaslIam.split(',');
  const pattern = /^b-([0-9]+)\.([A-Za-z0-9-]+\.[a-z0-9]+\.c[0-9]+)\.kafka\.ap-northeast-2\.amazonaws\.com:9098$/;
  const parsed = brokers.map(broker => pattern.exec(broker));
  if (brokers.length > 3 || parsed.some(match => !match)) fail('msk-bootstrap: 서울 리전 9098 broker 주소 1~3개가 필요하다');
  if (new Set(parsed.map(match => match![1])).size !== brokers.length || new Set(parsed.map(match => match![2])).size !== 1) {
    fail('msk-bootstrap: broker가 중복 없이 같은 cluster 주소에 있어야 한다');
  }
  // MSK DNS는 cluster 이름의 하이픈을 지운다(`soma-376-perf-telemetry` → `soma376perftelemetry`).
  if (!parsed[0]![2].startsWith(`${PERF_MSK.clusterName.replace(/-/g, '')}.`)) fail('msk-bootstrap: perf MSK cluster의 주소가 아니다');
  return [...brokers].sort().join(',');
}

/** 전체 `aws kafka list-nodes` 결과에서 broker 3대의 DNS만 읽는다. bootstrap 목록은 일부 broker일 수 있다. */
export function parsePerfMskNodes(value: JsonValue, bootstrapServers: string): string[] {
  if (!isObject(value) || !Array.isArray(value.NodeInfoList) || value.NextToken) fail('msk-nodes: pagination이 끝난 NodeInfoList가 필요하다');
  const suffix = bootstrapServers.split(',')[0].replace(/^b-[0-9]+\./, '').replace(/:9098$/, '');
  const nodes = value.NodeInfoList.filter(node => isObject(node) && node.NodeType === 'BROKER' && isObject(node.BrokerNodeInfo));
  if (nodes.length !== 3) fail('msk-nodes: broker 3개 전체가 필요하다');
  const hosts = nodes.map(node => {
    const broker = (node as JsonObject).BrokerNodeInfo as JsonObject;
    if (![1, 2, 3].includes(broker.BrokerId as number) || !Array.isArray(broker.Endpoints) || broker.Endpoints.length === 0) {
      fail('msk-nodes: broker ID·endpoint가 올바르지 않다');
    }
    const expected = `b-${broker.BrokerId}.${suffix}`;
    if (!broker.Endpoints.every(endpoint => typeof endpoint === 'string' && endpoint.replace(/:9098$/, '') === expected)) {
      fail('msk-nodes: bootstrap과 같은 cluster의 내부 broker DNS만 허용한다');
    }
    return expected;
  });
  if (new Set(hosts).size !== 3) fail('msk-nodes: broker가 중복된다');
  return hosts.sort();
}

export interface TelemetryJwtInput {
  readonly privateVersionId: string;
  readonly publicVersionId: string;
  readonly activeKid: string;
  readonly publicKeys: readonly { readonly kid: string; readonly alias: string }[];
}

export interface PerfRuntimeInput {
  readonly telemetryJwt: TelemetryJwtInput;
  /** enrollment-api replica. 준비 절차가 실행 중 0으로 만든다. Helm 재적용은 이 값으로 되돌린다(PLAN §5). */
  readonly enrollmentReplicas: 0 | 1;
  readonly jvmGcSafepointLog: boolean;
}

const VERSION_ID = /^[A-Za-z0-9-]{32,64}$/;
const KID = /^[^\[\]\u0000-\u001f\u007f]{1,128}$/;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9_-]*\.pem$/;

/** perf 전용의 작은 runtime 입력. 사용자 JWT·OIDC·dashboard·메일 입력은 받지 않는다(PLAN §4.2). */
export function parsePerfRuntimeInput(value: JsonValue): PerfRuntimeInput {
  const keys = ['telemetryJwt', 'enrollmentReplicas', 'jvmGcSafepointLog'];
  if (!isObject(value) || Object.keys(value).some(key => !keys.includes(key))) fail(`perf runtime: ${keys.join('·')}만 받는다`);
  const jwt = value.telemetryJwt;
  if (!isObject(jwt) || Object.keys(jwt).sort().join() !== 'activeKid,privateVersionId,publicKeys,publicVersionId') {
    fail('perf runtime: telemetryJwt는 privateVersionId·publicVersionId·activeKid·publicKeys다');
  }
  if (typeof jwt.privateVersionId !== 'string' || !VERSION_ID.test(jwt.privateVersionId)
    || typeof jwt.publicVersionId !== 'string' || !VERSION_ID.test(jwt.publicVersionId)) fail('perf runtime: telemetry JWT VersionId 형식이 아니다');
  if (typeof jwt.activeKid !== 'string' || !KID.test(jwt.activeKid)) fail('perf runtime: activeKid 형식이 아니다');
  if (!Array.isArray(jwt.publicKeys) || jwt.publicKeys.length < 1 || jwt.publicKeys.length > 32) fail('perf runtime: publicKeys 1~32개가 필요하다');
  const publicKeys = jwt.publicKeys.map(key => {
    if (!isObject(key) || Object.keys(key).sort().join() !== 'alias,kid' || typeof key.kid !== 'string' || !KID.test(key.kid)
      || typeof key.alias !== 'string' || !ALIAS.test(key.alias) || ['private.pem', 'telemetry-jwt-public.pem'].includes(key.alias)) {
      fail('perf runtime: publicKeys 항목은 kid·alias(.pem, 예약 이름 제외)다');
    }
    return { kid: key.kid, alias: key.alias };
  });
  if (new Set(publicKeys.map(key => key.kid)).size !== publicKeys.length || new Set(publicKeys.map(key => key.alias)).size !== publicKeys.length) {
    fail('perf runtime: kid·alias가 중복된다');
  }
  if (!publicKeys.some(key => key.kid === jwt.activeKid)) fail('perf runtime: activeKid가 publicKeys에 없다');
  const replicas = value.enrollmentReplicas ?? 1;
  if (replicas !== 0 && replicas !== 1) fail('perf runtime: enrollmentReplicas는 0 또는 1이다');
  const gc = value.jvmGcSafepointLog ?? false;
  if (typeof gc !== 'boolean') fail('perf runtime: jvmGcSafepointLog는 boolean이다');
  return {
    telemetryJwt: { privateVersionId: jwt.privateVersionId, publicVersionId: jwt.publicVersionId, activeKid: jwt.activeKid, publicKeys },
    enrollmentReplicas: replicas, jvmGcSafepointLog: gc,
  };
}

/** load-tests v2 request. schema와 ready 상태를 확인한다. 바이트 SHA-256이 다른 결과 파일의 연결 고리다. */
export function loadPerfRequest(schemas: Schemas, bytes: Uint8Array): { request: JsonObject; sha256: string } {
  const request = parseInputJson(bytes, 'request');
  if (!isObject(request)) fail('request는 객체여야 한다');
  const errors = environmentSchemas(request.schema_version).validate('environment-request', request);
  if (errors.length) fail(`request: 환경 schema 위반 ${errors.slice(0, 5).map(([path, keyword]) => `${path || '/'}:${keyword}`).join(', ')}`);
  if (!isObject(request) || request.status !== 'ready') fail('request: status ready인 요청만 배포 입력으로 쓴다');
  return { request, sha256: sha256(bytes) };
}
