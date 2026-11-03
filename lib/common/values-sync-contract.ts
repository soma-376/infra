/** dev와 cicd 사이의 generated values 조회 계약. 역할 이름은 스택 참조 없이 공유한다. */
export const VALUES_SYNC_CONTRACT = {
  deployRoleName: 'soma-376-infra-dev-deploy',
  readerRoleName: 'soma-376-dev-eks-values-reader',
  kubernetesGroup: 'pulsemetry:dev:generated-values-reader',
} as const;
