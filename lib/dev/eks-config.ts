import { App } from 'aws-cdk-lib/core';

export const DEV_EKS_CLUSTER_NAME = 'soma-376-dev-eks';
export const DEV_EKS_OPERATOR_ROLE_NAME = 'soma-376-dev-eks-operator';
export const DEV_EKS_RELAY_INSTANCE_TYPE = 't4g.micro';
export const DEV_EKS_RELAY_SESSION_DOCUMENT_NAME = 'soma-376-dev-eks-api-tunnel';
export const DEV_EKS_NAMESPACE = 'pulsemetry-dev';
export const DEV_EKS_VERSION = '1.36';
export const DEV_EKS_NODE_PORTS = { ingest: 30416, enrollment: 30080, dashboard: 30081 } as const;

export interface DevEksConfig {
  readonly enabled: boolean;
  readonly archivePrefix: 'eks_validation' | 'eks';
}

/** 무인자 synth는 기존 ECS만 유지한다. 활성화 입력 오타는 조용히 기본값으로 바꾸지 않는다. */
export function loadDevEksConfig(app: App): DevEksConfig {
  if (app.node.tryGetContext('devEksApiAllowedCidrs') !== undefined) {
    throw new Error('devEksApiAllowedCidrs는 제거되었습니다. 해당 context를 삭제하고 SSM 릴레이 터널로 private EKS API에 접근하세요');
  }
  const raw = app.node.tryGetContext('devEksEnabled');
  if (raw !== undefined && ![true, false, 'true', 'false'].includes(raw)) {
    throw new Error('devEksEnabled는 true 또는 false여야 한다');
  }
  const enabled = raw === true || raw === 'true';
  if (!enabled) return { enabled: false, archivePrefix: 'eks_validation' };
  const archivePrefix = app.node.tryGetContext('devEksArchivePrefix') ?? 'eks_validation';
  if (archivePrefix !== 'eks_validation' && archivePrefix !== 'eks') {
    throw new Error('devEksArchivePrefix는 eks_validation 또는 eks여야 한다');
  }
  return { enabled, archivePrefix };
}
