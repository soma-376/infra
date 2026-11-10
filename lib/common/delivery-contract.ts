/** PROJ-311의 게시·관측 역할은 기존 이미지 push·values reader와 분리한다. */
export const DELIVERY_CONTRACT = {
  promotionRoleName: 'soma-376-backend-dev-gitops',
  observerRoleName: 'soma-376-dev-eks-delivery-observer',
  kubernetesGroup: 'pulsemetry:dev:gitops-observer',
  environment: 'dev-gitops',
} as const;
