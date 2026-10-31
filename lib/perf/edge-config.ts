import { App, Environment } from 'aws-cdk-lib/core';

export const PERF_GATEWAY_HOST = 'perf-api.pulsemetry.co.kr';
export const PERF_GATEWAY_HTTPS = `https://${PERF_GATEWAY_HOST}`;
export const PERF_GATEWAY_NODE_PORT = 30082;
export const PERF_GATEWAY_TG_NAME = 'soma-376-perf-eks-gateway';
export const PERF_TG_CLUSTER_TAG = 'pulsemetry:eks-cluster';
export const PERF_OTLP_PATHS = ['/v1/traces', '/v1/metrics', '/v1/logs'] as const;
export interface PerfEdgeConfig { readonly certificateArn: string }
const CERTIFICATE = /^arn:aws:acm:ap-northeast-2:([0-9]{12}):certificate\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 외부 인증서 원본은 runtime 참조만 받는다. 이 입력이 없으면 기존 내부 전용 합성을 보존한다. */
export function loadPerfEdgeConfig(app: App): PerfEdgeConfig | undefined {
  const arn = app.node.tryGetContext('perfCertificateArn');
  if (arn === undefined) return undefined;
  if (typeof arn !== 'string' || !CERTIFICATE.test(arn)) throw new Error('perfCertificateArn은 서울 리전의 유효한 ACM ARN이어야 한다');
  return { certificateArn: arn };
}
export function validatePerfEdgeEnvironment(edge: PerfEdgeConfig | undefined, env: Environment): void {
  if (!edge) return;
  if (env.region !== 'ap-northeast-2' || !env.account || CERTIFICATE.exec(edge.certificateArn)?.[1] !== env.account) {
    throw new Error('perfCertificateArn은 확정한 배포 계정·서울 리전과 같아야 한다');
  }
}
