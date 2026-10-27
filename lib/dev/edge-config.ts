import { App, Environment } from 'aws-cdk-lib/core';

/** 외부 ACM 원본의 수명은 관리하지 않고 공개 origin과 인증서 참조를 받는다. (ADR-0033·0040) */
export interface DevEdgeConfig {
  readonly eksCertificateArn?: string;
  readonly eksAdditionalCertificateArns?: readonly string[];
  readonly eksAdditionalCertificateLogicalIds?: Readonly<Record<string, string>>;
  readonly eksPublicBaseUrl?: string;
  readonly httpRedirectEnabled: boolean;
}

const CERTIFICATE_ARN = /^arn:aws:acm:ap-northeast-2:(\d{12}):certificate\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function certificateArn(raw: unknown, key: string): string {
  if (typeof raw !== 'string' || raw !== raw.trim() || !CERTIFICATE_ARN.test(raw)) {
    throw new Error(`${key}는 ap-northeast-2의 유효한 ACM certificate ARN이어야 한다`);
  }
  return raw;
}

function additionalCertificateArns(app: App, defaultArn?: string): string[] {
  const key = 'devEksAdditionalCertificateArns';
  let raw: unknown = app.node.tryGetContext(key);
  if (raw === undefined) return [];
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { throw new Error(`${key}는 배열 또는 JSON 배열 문자열이어야 한다`); }
  }
  if (!Array.isArray(raw)) throw new Error(`${key}는 배열 또는 JSON 배열 문자열이어야 한다`);
  const arns = raw.map((value, index) => certificateArn(value, `${key}[${index}]`));
  if (arns.length && !defaultArn) throw new Error(`${key}는 devEksCertificateArn과 함께 사용해야 한다`);
  if (new Set(arns).size !== arns.length || arns.includes(defaultArn ?? '')) {
    throw new Error(`${key}는 중복되거나 기본 인증서와 같을 수 없다`);
  }
  return arns.sort();
}

function additionalCertificateLogicalIds(app: App, arns: readonly string[]): Record<string, string> {
  const key = 'devEksAdditionalCertificateLogicalIds';
  let raw: unknown = app.node.tryGetContext(key);
  if (raw === undefined) return {};
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); }
    catch { throw new Error(`${key}는 ARN → 기존 logical ID 객체 또는 JSON 객체 문자열이어야 한다`); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) {
    throw new Error(`${key}는 비어 있지 않은 ARN → 기존 logical ID 객체여야 한다`);
  }
  const entries = Object.entries(raw);
  for (const [arn, id] of entries) {
    if (!arns.includes(arn) || typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,254}$/.test(id)) {
      throw new Error(`${key}는 추가 인증서 ARN과 유효한 CloudFormation logical ID만 허용한다`);
    }
  }
  if (new Set(entries.map(([, id]) => id)).size !== entries.length) {
    throw new Error(`${key}의 logical ID는 중복될 수 없다`);
  }
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}

function publicBaseUrl(app: App, defaultArn?: string): string | undefined {
  const key = 'devEksPublicBaseUrl';
  const raw: unknown = app.node.tryGetContext(key);
  if (raw === undefined) return undefined;
  let url: URL;
  try { url = new URL(typeof raw === 'string' ? raw : ''); }
  catch { throw new Error(`${key}는 경로·인증정보·query·fragment·port 없는 HTTPS origin이어야 한다`); }
  // 원문과 origin을 비교해 URL 파서가 지우는 빈 ?/#, 기본 port, 공백도 거부한다.
  if (typeof raw !== 'string' || !/^https:\/\/[a-zA-Z0-9.-]+$/.test(raw) ||
      url.protocol !== 'https:' || url.port || raw !== url.origin) {
    throw new Error(`${key}는 경로·인증정보·query·fragment·port 없는 HTTPS origin이어야 한다`);
  }
  if (!defaultArn) throw new Error(`${key}는 devEksCertificateArn과 함께 사용해야 한다`);
  return url.origin;
}

export function loadDevEdgeConfig(app: App): DevEdgeConfig {
  const raw: unknown = app.node.tryGetContext('devEksCertificateArn');
  const eks = raw === undefined ? undefined : certificateArn(raw, 'devEksCertificateArn');
  const additional = additionalCertificateArns(app, eks);
  const logicalIds = additionalCertificateLogicalIds(app, additional);
  const origin = publicBaseUrl(app, eks);
  const redirect: unknown = app.node.tryGetContext('devHttpRedirectEnabled');
  if (redirect !== undefined && redirect !== true && redirect !== false && redirect !== 'true' && redirect !== 'false') {
    throw new Error('devHttpRedirectEnabled는 true 또는 false여야 한다');
  }
  return {
    eksCertificateArn: eks,
    eksAdditionalCertificateArns: additional,
    eksAdditionalCertificateLogicalIds: logicalIds,
    eksPublicBaseUrl: origin,
    httpRedirectEnabled: redirect !== false && redirect !== 'false',
  };
}

/** App context 파싱 뒤, 리소스를 만들기 전에 실제 합성 대상 계정과 대조한다. */
export function validateDevEdgeEnvironment(edge: DevEdgeConfig, env: Environment): void {
  const certificates: [string, string | undefined][] = [
    ['devEksCertificateArn', edge.eksCertificateArn],
    ...(edge.eksAdditionalCertificateArns ?? []).map((arn, index): [string, string] =>
      [`devEksAdditionalCertificateArns[${index}]`, arn]),
  ];
  for (const [key, arn] of certificates) {
    if (arn === undefined) continue;
    const match = CERTIFICATE_ARN.exec(arn);
    if (!match || arn !== arn.trim() || !env.account || !/^\d{12}$/.test(env.account) || match[1] !== env.account) {
      throw new Error(`${key}의 계정은 확정된 배포 계정(CDK_DEFAULT_ACCOUNT)과 같아야 한다`);
    }
    if (env.region !== 'ap-northeast-2') {
      throw new Error(`${key}의 배포 리전(CDK_DEFAULT_REGION)은 ap-northeast-2여야 한다`);
    }
  }
}
