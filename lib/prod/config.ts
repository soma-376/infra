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
 * 운영이 읽는 ECR 이미지 태그 (ADR-0024 7번).
 *
 * dev/prod 가 같은 ECR 레포를 공유하고 태그로만 갈린다 (ADR-0021 5번). 예전에는 prod 가
 * 태그를 아예 주지 않아 `latest` 로 해석됐고 dev 기본값도 `latest` 였다 - 그래서 dev 빌드가
 * 곧 운영 이미지가 됐다. 두 환경에 서로 다른 고정 태그를 주는 것이 그 경로를 닫는다.
 *
 * **dev 의 `devImageTag` 와 달리 context 오버라이드를 두지 않는다.** 운영 태그를 CLI 인자로
 * 바꿀 수 있게 하면 "지금 운영에 어떤 이미지가 있는가"의 답이 코드가 아니라 누군가의 셸
 * 히스토리로 옮겨간다. 운영 이미지 승격은 이 태그를 push 하는 것으로만 한다. 롤백도 인프라
 * 재합성이 아니라 ECR 에서 이 태그를 이전 매니페스트에 다시 붙이고 force-new-deployment 다.
 *
 * **이 태그에 이미지가 없으면 synth·test·deploy 가 전부 통과하고 태스크 기동에서만
 * `CannotPullContainerError` 로 죽는다** (ADR-0007 과 같은 실패 모드). 배포 런북의 재태깅
 * 단계가 유일한 방어선이다 (`AGENTS.md` 6장).
 */
export const PROD_IMAGE_TAG = 'prod';

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
