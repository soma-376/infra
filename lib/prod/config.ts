import { App } from 'aws-cdk-lib/core';

/**
 * 전 스택 공통 태그. 비용 배분(Cost Explorer 태그 분해)과 소유권 식별에 쓴다.
 */
export const COMMON_TAGS: Readonly<Record<string, string>> = {
  Org: 'soma-376',
  Env: 'mvp',
  ManagedBy: 'cdk',
};

/**
 * MVP 워크로드를 고정할 primary AZ의 VPC availabilityZones 인덱스 (ADR-0011).
 */
export const PRIMARY_AZ_INDEX = 0;

/**
 * VPC 서브넷 그룹 이름 (network-stack 과 소비 스택이 공유).
 */
export const SUBNET_GROUP = {
  public: 'public',
  app: 'app',
  db: 'db',
} as const;

/**
 * EdgeStack 모드 분기 입력. certificateArn 이 있으면 모드 A(HTTPS + ALB 인증),
 * 없으면 모드 B(HTTP 폴백 + synth 경고).
 */
export interface EdgeConfig {
  readonly certificateArn?: string;
  readonly domainName?: string;
  readonly cognitoDomainPrefix: string;
}

/**
 * 전체 인프라 설정.
 */
export interface InfraConfig {
  readonly edge: EdgeConfig;
}

/**
 * CDK context 에서 설정을 로드한다.
 * context 키: certificateArn, domainName, cognitoDomainPrefix.
 */
export function loadConfig(app: App): InfraConfig {
  const certificateArn = app.node.tryGetContext('certificateArn') as
    | string
    | undefined;
  const domainName = app.node.tryGetContext('domainName') as string | undefined;
  const cognitoDomainPrefix =
    (app.node.tryGetContext('cognitoDomainPrefix') as string | undefined) ??
    DEFAULT_COGNITO_DOMAIN_PREFIX;

  return {
    edge: {
      certificateArn,
      domainName,
      cognitoDomainPrefix,
    },
  };
}

/**
 * Cognito 호스팅 도메인 prefix 는 리전 내 전역 유일해야 하므로 suffix 를 붙인 기본값.
 */
export const DEFAULT_COGNITO_DOMAIN_PREFIX = 'soma-376-mvp-auth';
