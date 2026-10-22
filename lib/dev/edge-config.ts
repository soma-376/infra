import { App, Environment } from 'aws-cdk-lib/core';

/** 외부 ACM 원본의 수명은 관리하지 않고 ALB별 참조만 받는다. (ADR-0033) */
export interface DevEdgeConfig {
  readonly eksCertificateArn?: string;
  readonly httpRedirectEnabled: boolean;
}

const CERTIFICATE_ARN = /^arn:aws:acm:ap-northeast-2:(\d{12}):certificate\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function certificateArn(app: App, key: string): string | undefined {
  const raw: unknown = app.node.tryGetContext(key);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw !== raw.trim() || !CERTIFICATE_ARN.test(raw)) {
    throw new Error(`${key}는 ap-northeast-2의 유효한 ACM certificate ARN이어야 한다`);
  }
  return raw;
}

export function loadDevEdgeConfig(app: App): DevEdgeConfig {
  const eks = certificateArn(app, 'devEksCertificateArn');
  const redirect: unknown = app.node.tryGetContext('devHttpRedirectEnabled');
  if (redirect !== undefined && redirect !== true && redirect !== false && redirect !== 'true' && redirect !== 'false') {
    throw new Error('devHttpRedirectEnabled는 true 또는 false여야 한다');
  }
  return {
    eksCertificateArn: eks,
    httpRedirectEnabled: redirect !== false && redirect !== 'false',
  };
}

/** App context 파싱 뒤, 리소스를 만들기 전에 실제 합성 대상 계정과 대조한다. */
export function validateDevEdgeEnvironment(edge: DevEdgeConfig, env: Environment): void {
  for (const [key, arn] of [
    ['devEksCertificateArn', edge.eksCertificateArn],
  ] as const) {
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
