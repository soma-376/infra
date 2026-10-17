import { Construct } from 'constructs';
import {
  CfnListenerRule,
  IApplicationListener,
  IApplicationTargetGroup,
  ListenerAction,
  ListenerCondition,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';

import { DEV_OTLP_PATHS } from './config';

type AppOwner = 'enrollment' | 'dashboard';
type AppMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface DevAppRoute {
  readonly owner: AppOwner;
  readonly pathTemplate: string;
  readonly methods: readonly AppMethod[];
  readonly corsMethods: readonly AppMethod[];
}

export interface DevAppRouteTargets {
  readonly enrollment: IApplicationTargetGroup;
  readonly dashboard: IApplicationTargetGroup;
  readonly ingest: IApplicationTargetGroup;
}

const ORGANIZATION = '/api/v1/organizations/{organizationId}';

/** 허브 dashboard-api 계약 §2-1. 각 조회와 그 GET preflight를 함께 정의한다. */
const DASHBOARD_PATHS = [
  `${ORGANIZATION}/analytics/overview`,
  `${ORGANIZATION}/analytics/teams`,
  `${ORGANIZATION}/analytics/teams/{teamId}`,
  `${ORGANIZATION}/analytics/teams/{teamId}/users`,
  `${ORGANIZATION}/teams`,
  `${ORGANIZATION}/members/dashboard`,
  `${ORGANIZATION}/members`,
  `${ORGANIZATION}/members/unassigned`,
  `${ORGANIZATION}/seat-reclaim-candidates`,
  `${ORGANIZATION}/members/{memberId}/seats`,
  `${ORGANIZATION}/vendors/{vendorId}/seats`,
  `${ORGANIZATION}/contract-input-status`,
  `${ORGANIZATION}/settings`,
  `${ORGANIZATION}/vendors`,
  `${ORGANIZATION}/vendors/{vendorId}`,
  `${ORGANIZATION}/installations`,
  `${ORGANIZATION}/alerts`,
  `${ORGANIZATION}/alerts/{alertId}`,
  `${ORGANIZATION}/operations/{operationId}`,
  `${ORGANIZATION}/ingest-status`,
  '/api/v1/vendor-catalog',
  '/api/v1/vendor-catalog/{vendorId}/plans',
] as const;

/** 허브 계약 §2-2. 같은 URI의 dashboard GET과 enrollment 명령을 분리한다. */
const ENROLLMENT_ORGANIZATION_ROUTES: readonly [string, readonly AppMethod[]][] = [
  ['onboarding', ['GET']],
  ['invitations', ['GET']],
  ['teams', ['POST']],
  ['teams/{teamId}', ['PATCH', 'DELETE']],
  ['member-team-assignments', ['POST']],
  ['members/{memberId}', ['PATCH']],
  ['invitations/batch', ['POST']],
  ['invitations/{invitationId}/revoke', ['POST']],
  ['invitations/{invitationId}/reissue', ['POST']],
  ['members/{memberId}/installation-invitations', ['POST']],
  ['vendors', ['POST']],
  ['vendors/{vendorId}', ['PATCH', 'DELETE']],
  ['vendors/{vendorId}/contract', ['PUT', 'DELETE']],
  ['collection-policy', ['PUT']],
  ['onboarding/complete', ['POST']],
  ['installation-update-notifications', ['POST']],
  ['vendors/{vendorId}/connection', ['PUT', 'DELETE']],
  ['vendors/{vendorId}/connection/verify', ['POST']],
  ['vendors/{vendorId}/connection/sync', ['POST']],
  ['vendors/{vendorId}/seats', ['POST']],
  ['vendors/{vendorId}/seats/import', ['POST']],
  ['vendors/{vendorId}/seats/{seatId}', ['PATCH']],
  ['vendors/{vendorId}/seats/{seatId}/release', ['POST']],
  ['seat-reclaims/preview', ['POST']],
  ['seat-reclaims', ['POST']],
  ['seat-reclaims/{operationId}/restore', ['POST']],
  ['operations/{operationId}/targets/{targetId}/confirm', ['POST']],
  ['operations/{operationId}/targets/{targetId}/cancel', ['POST']],
  ['settings/alert-rules/{ruleId}', ['PATCH']],
  ['alerts/{alertId}/acknowledge', ['POST']],
];

/** 허브 계약 §2-3. 마지막 열은 앱이 지원하는 preflight의 유무다. */
const ENROLLMENT_EXISTING_ROUTES: readonly [string, AppMethod, boolean][] = [
  ['/api/v1/auth/organizations', 'POST', true],
  ['/api/v1/auth/token', 'POST', true],
  ['/api/v1/auth/cli/token', 'POST', true],
  ['/api/v1/auth/refresh', 'POST', true],
  ['/api/v1/auth/logout', 'POST', true],
  ['/api/v1/auth/me', 'GET', true],
  ['/api/v1/auth/oidc/authorize', 'GET', false],
  ['/api/v1/auth/oidc/callback/{registrationId}', 'GET', false],
  ['/api/v1/manifest', 'GET', true],
  ['/api/v1/enroll', 'POST', false],
  ['/api/v1/installations/telemetry-token', 'POST', false],
  ['/api/v1/installations/{installationId}/heartbeat', 'POST', false],
  ['/api/v1/invitations', 'POST', false],
  ['/api/v1/invitations/{id}/revoke', 'POST', false],
  ['/api/v1/inquiries', 'POST', true],
  ['/api/v1/check-updates', 'GET', false],
  ['/windows', 'GET', false],
  ['/unix', 'GET', false],
  ['/bin/{filename}', 'GET', false],
];

/**
 * ECS와 EKS 검증 ALB가 함께 소비하는 공개 업무 경로다. Origin 허용·인증·CORS 응답은
 * 앱이 판단하고, edge는 명시한 path/method/preflight만 전달한다. (ADR-0029)
 */
export const DEV_APP_ROUTES: readonly DevAppRoute[] = [
  ...DASHBOARD_PATHS.map((pathTemplate): DevAppRoute => ({
    owner: 'dashboard', pathTemplate, methods: ['GET'], corsMethods: ['GET'],
  })),
  ...ENROLLMENT_ORGANIZATION_ROUTES.map(([suffix, methods]): DevAppRoute => ({
    owner: 'enrollment', pathTemplate: `${ORGANIZATION}/${suffix}`, methods, corsMethods: methods,
  })),
  ...ENROLLMENT_EXISTING_ROUTES.map(([pathTemplate, method, cors]): DevAppRoute => ({
    owner: 'enrollment', pathTemplate, methods: [method], corsMethods: cors ? [method] : [],
  })),
];

function pathTemplateRegex(pathTemplate: string): string {
  // ALB의 *는 slash도 매칭한다. template parameter는 비어 있지 않은 한 segment로 제한한다.
  const segments = pathTemplate.split('/').map((segment) =>
    /^\{[A-Za-z][A-Za-z0-9]*\}$/.test(segment)
      ? '[^/]+'
      : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return `^${segments.join('/')}$`;
}

/**
 * 기존 WAF의 조직/auth prefix 검사 범위는 보존한다. 조직 밖 dashboard URI만 추가하며,
 * ALB의 method별 전달 범위나 등록 rate 세 조건을 WAF 앱 검사와 혼동하지 않는다.
 */
export const DEV_DASHBOARD_WAF_EXACT_PATHS = DASHBOARD_PATHS
  .filter((path) => !path.startsWith('/api/v1/organizations/') && !path.includes('{'));
export const DEV_DASHBOARD_WAF_REGEX_PATHS = DASHBOARD_PATHS
  .filter((path) => !path.startsWith('/api/v1/organizations/') && path.includes('{'))
  .map(pathTemplateRegex);

/** 설치된 CDK L2에는 regex factory가 없어 L1이 지원하는 조건을 그대로 렌더링한다. */
class RegexPathCondition extends ListenerCondition {
  constructor(private readonly regexValues: readonly string[]) {
    super();
  }

  renderRawCondition(): CfnListenerRule.RuleConditionProperty {
    return { field: 'path-pattern', pathPatternConfig: { regexValues: [...this.regexValues] } };
  }
}

const METHODS: readonly AppMethod[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const PATHS_PER_RULE = 3;
const RULES_PER_METHOD = 20;

/**
 * 공개 listener는 호출자가 open:false와 default 404로 만든다. 우선순위 1은 기존 OTLP이며,
 * 100~199/200~299는 dashboard/enrollment 일반 요청, 300~399/400~499는 각 preflight다.
 * method마다 20개를 예약한다. path 3 + method 1 + preflight header 1 = 평가 최대 5개다.
 * URI normalization과 WAF 원문 분류의 동치는 로컬 synth로 증명하지 않는다. (ADR-0027)
 */
export function installDevAppRoutes(
  scope: Construct,
  listener: IApplicationListener,
  targets: DevAppRouteTargets,
): void {
  listener.addAction('DevOtlpForward', {
    priority: 1,
    conditions: [ListenerCondition.pathPatterns([...DEV_OTLP_PATHS])],
    action: ListenerAction.forward([targets.ingest]),
  });

  for (const owner of ['dashboard', 'enrollment'] as const) {
    for (const preflight of [false, true]) {
      const base = (owner === 'dashboard' ? 100 : 200) + (preflight ? 200 : 0);
      for (const [methodIndex, method] of METHODS.entries()) {
        const paths = DEV_APP_ROUTES
          .filter((route) => route.owner === owner
            && (preflight ? route.corsMethods : route.methods).includes(method))
          .map((route) => pathTemplateRegex(route.pathTemplate));
        const groupCount = Math.ceil(paths.length / PATHS_PER_RULE);
        if (groupCount > RULES_PER_METHOD) {
          throw new Error(`${scope.node.path}: ${owner} ${method} 라우팅의 예약 우선순위 범위를 초과했다`);
        }
        for (let group = 0; group < groupCount; group += 1) {
          const conditions: ListenerCondition[] = [
            new RegexPathCondition(paths.slice(group * PATHS_PER_RULE, (group + 1) * PATHS_PER_RULE)),
            ListenerCondition.httpRequestMethods([preflight ? 'OPTIONS' : method]),
          ];
          if (preflight) {
            conditions.push(ListenerCondition.httpHeader('Access-Control-Request-Method', [method]));
          }
          listener.addAction(`Dev${owner === 'dashboard' ? 'Dashboard' : 'Enrollment'}${method}${preflight ? 'Preflight' : 'Forward'}${group + 1}`, {
            priority: base + methodIndex * RULES_PER_METHOD + group,
            conditions,
            action: ListenerAction.forward([targets[owner]]),
          });
        }
      }
    }
  }
}
