import { App } from 'aws-cdk-lib/core';
import { isIP } from 'node:net';

export const DEV_EKS_CLUSTER_NAME = 'soma-376-dev-eks';
export const DEV_EKS_OPERATOR_ROLE_NAME = 'soma-376-dev-eks-operator';
export const DEV_EKS_NAMESPACE = 'pulsemetry-dev';
export const DEV_EKS_VERSION = '1.36';
export const DEV_EKS_NODE_PORTS = { ingest: 30416, enrollment: 30080, dashboard: 30081 } as const;

export interface DevEksConfig {
  readonly enabled: boolean;
  readonly publicAccessCidrs: string[];
  readonly archivePrefix: 'eks_validation' | 'eks';
}

/** 무인자 synth는 기존 ECS만 유지한다. 활성화 입력 오타는 조용히 기본값으로 바꾸지 않는다. */
export function loadDevEksConfig(app: App): DevEksConfig {
  const raw = app.node.tryGetContext('devEksEnabled');
  if (raw !== undefined && ![true, false, 'true', 'false'].includes(raw)) {
    throw new Error('devEksEnabled는 true 또는 false여야 한다');
  }
  const enabled = raw === true || raw === 'true';
  if (!enabled) return { enabled: false, publicAccessCidrs: [], archivePrefix: 'eks_validation' };
  const publicAccessCidrs = String(app.node.tryGetContext('devEksApiAllowedCidrs') ?? '')
    .split(',').map(s => s.trim());
  if (publicAccessCidrs.length > 40 || publicAccessCidrs.some(cidr => {
    const [ip, mask, extra] = cidr.split('/');
    return extra !== undefined || isIP(ip) !== 4 || !/^\d+$/.test(mask ?? '') || Number(mask) < 1 || Number(mask) > 32;
  })) throw new Error('devEksApiAllowedCidrs에 전면 공개가 아닌 IPv4 CIDR을 명시해야 한다');
  const archivePrefix = app.node.tryGetContext('devEksArchivePrefix') ?? 'eks_validation';
  if (archivePrefix !== 'eks_validation' && archivePrefix !== 'eks') {
    throw new Error('devEksArchivePrefix는 eks_validation 또는 eks여야 한다');
  }
  return { enabled, publicAccessCidrs: [...new Set(publicAccessCidrs)], archivePrefix };
}
