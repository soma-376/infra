import { App, Stack } from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  ListenerAction,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import {
  DEV_DASHBOARD_WAF_EXACT_PATHS,
  DEV_DASHBOARD_WAF_REGEX_PATHS,
  installDevAppRoutes,
} from '../../lib/dev/app-routing';

type Owner = 'enrollment' | 'dashboard' | 'ingest';
interface RequestFixture {
  readonly path: string;
  readonly method: string;
  readonly owner: Owner;
  readonly cors: boolean;
}

// 허브 계약 §2에서 독립적으로 적은 실제 요청이다. 구현의 route 배열로 기대값을 만들지 않는다.
const ORGANIZATION = '/api/v1/organizations/org-1';
const DASHBOARD_PATHS = [
  `${ORGANIZATION}/analytics/overview`,
  `${ORGANIZATION}/analytics/teams`,
  `${ORGANIZATION}/analytics/teams/team-2`,
  `${ORGANIZATION}/analytics/teams/team-2/users`,
  `${ORGANIZATION}/teams`,
  `${ORGANIZATION}/members/dashboard`,
  `${ORGANIZATION}/members`,
  `${ORGANIZATION}/members/unassigned`,
  `${ORGANIZATION}/seat-reclaim-candidates`,
  `${ORGANIZATION}/members/member-3/seats`,
  `${ORGANIZATION}/vendors/vendor-4/seats`,
  `${ORGANIZATION}/contract-input-status`,
  `${ORGANIZATION}/settings`,
  `${ORGANIZATION}/vendors`,
  `${ORGANIZATION}/vendors/vendor-4`,
  `${ORGANIZATION}/installations`,
  `${ORGANIZATION}/alerts`,
  `${ORGANIZATION}/alerts/alert-5`,
  `${ORGANIZATION}/operations/op-6`,
  `${ORGANIZATION}/ingest-status`,
  '/api/v1/vendor-catalog',
  '/api/v1/vendor-catalog/vendor-4/plans',
];

const ORGANIZATION_COMMANDS: readonly [string, string[]][] = [
  ['onboarding', ['GET']],
  ['invitations', ['GET']],
  ['teams', ['POST']],
  ['teams/team-2', ['PATCH', 'DELETE']],
  ['member-team-assignments', ['POST']],
  ['members/member-3', ['PATCH']],
  ['invitations/batch', ['POST']],
  ['invitations/invitation-7/revoke', ['POST']],
  ['invitations/invitation-7/reissue', ['POST']],
  ['members/member-3/installation-invitations', ['POST']],
  ['vendors', ['POST']],
  ['vendors/vendor-4', ['PATCH', 'DELETE']],
  ['vendors/vendor-4/contract', ['PUT', 'DELETE']],
  ['collection-policy', ['PUT']],
  ['onboarding/complete', ['POST']],
  ['installation-update-notifications', ['POST']],
  ['vendors/vendor-4/connection', ['PUT', 'DELETE']],
  ['vendors/vendor-4/connection/verify', ['POST']],
  ['vendors/vendor-4/connection/sync', ['POST']],
  ['vendors/vendor-4/seats', ['POST']],
  ['vendors/vendor-4/seats/import', ['POST']],
  ['vendors/vendor-4/seats/seat-8', ['PATCH']],
  ['vendors/vendor-4/seats/seat-8/release', ['POST']],
  ['seat-reclaims/preview', ['POST']],
  ['seat-reclaims', ['POST']],
  ['seat-reclaims/op-6/restore', ['POST']],
  ['operations/op-6/targets/target-9/confirm', ['POST']],
  ['operations/op-6/targets/target-9/cancel', ['POST']],
  ['settings/alert-rules/rule-10', ['PATCH']],
  ['alerts/alert-5/acknowledge', ['POST']],
];

const EXISTING: readonly [string, string, boolean][] = [
  ['/api/v1/auth/organizations', 'POST', true],
  ['/api/v1/auth/token', 'POST', true],
  ['/api/v1/auth/cli/token', 'POST', true],
  ['/api/v1/auth/refresh', 'POST', true],
  ['/api/v1/auth/logout', 'POST', true],
  ['/api/v1/auth/me', 'GET', true],
  ['/api/v1/auth/oidc/authorize', 'GET', false],
  ['/api/v1/auth/oidc/callback/google', 'GET', false],
  ['/api/v1/manifest', 'GET', true],
  ['/api/v1/enroll', 'POST', false],
  ['/api/v1/installations/telemetry-token', 'POST', false],
  ['/api/v1/installations/installation-11/heartbeat', 'POST', false],
  ['/api/v1/invitations', 'POST', false],
  ['/api/v1/invitations/invitation-7/revoke', 'POST', false],
  ['/api/v1/inquiries', 'POST', true],
  ['/api/v1/check-updates', 'GET', false],
  ['/windows', 'GET', false],
  ['/unix', 'GET', false],
  ['/bin/telemetryctl-linux-arm64', 'GET', false],
];

const FIXTURES: RequestFixture[] = [
  ...DASHBOARD_PATHS.map((path): RequestFixture => ({ path, method: 'GET', owner: 'dashboard', cors: true })),
  ...ORGANIZATION_COMMANDS.flatMap(([suffix, methods]) => methods.map((method): RequestFixture => ({
    path: `${ORGANIZATION}/${suffix}`, method, owner: 'enrollment', cors: true,
  }))),
  ...EXISTING.map(([path, method, cors]): RequestFixture => ({ path, method, owner: 'enrollment', cors })),
  // edge는 ID의 형식을 검증하지 않는다. 같은 문자열도 PATCH에서는 {memberId} 위치다.
  ...['dashboard', 'unassigned'].map((memberId): RequestFixture => ({
    path: `${ORGANIZATION}/members/${memberId}`, method: 'PATCH', owner: 'enrollment', cors: true,
  })),
  { path: `${ORGANIZATION}/vendors/vendor-4/seats/import`, method: 'PATCH', owner: 'enrollment', cors: true },
];

/** ALB를 호출하지 않고 합성한 조건·forward action에 canonical 요청을 대입한다. */
function buildRoutingFixture() {
  const app = new App();
  const stack = new Stack(app, 'Routes', { env: { account: '111111111111', region: 'ap-northeast-2' } });
  const vpc = new Vpc(stack, 'Vpc', {
    maxAzs: 2, natGateways: 0,
    subnetConfiguration: [{ name: 'public', subnetType: SubnetType.PUBLIC }],
  });
  const listenerIds: Record<string, string> = {};
  const owners = new Map<string, Owner>();
  for (const runtime of ['Ecs', 'Eks']) {
    const alb = new ApplicationLoadBalancer(stack, `${runtime}Alb`, { vpc, internetFacing: true });
    const listener = alb.addListener('Http', {
      port: 80, protocol: ApplicationProtocol.HTTP, open: false,
      defaultAction: ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found' }),
    });
    const target = (owner: Owner): ApplicationTargetGroup => {
      const group = new ApplicationTargetGroup(stack, `${runtime}${owner}Tg`, {
        vpc, port: 8080, protocol: ApplicationProtocol.HTTP, targetType: TargetType.INSTANCE,
      });
      owners.set(stack.getLogicalId(group.node.defaultChild as any), owner);
      return group;
    };
    installDevAppRoutes(stack, listener, {
      enrollment: target('enrollment'), dashboard: target('dashboard'), ingest: target('ingest'),
    });
    listenerIds[runtime] = stack.getLogicalId(listener.node.defaultChild as any);
  }
  const template = Template.fromStack(stack);
  const rules = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::ListenerRule'))
    .map((resource: any) => resource.Properties)
    .sort((left, right) => left.Priority - right.Priority);
  const runtimeRules = (runtime: string) => rules.filter((rule) => rule.ListenerArn.Ref === listenerIds[runtime]);
  const evaluate = (runtime: string, method: string, path: string, requestedMethod?: string): Owner | undefined => {
    const rule = runtimeRules(runtime).find((candidate) => candidate.Conditions.every((condition: any) => {
      if (condition.Field === 'path-pattern') {
        const config = condition.PathPatternConfig;
        return config.RegexValues
          ? config.RegexValues.some((regex: string) => new RegExp(regex).test(path))
          : config.Values.includes(path);
      }
      if (condition.Field === 'http-request-method') return condition.HttpRequestMethodConfig.Values.includes(method);
      if (condition.Field === 'http-header') {
        expect(condition.HttpHeaderConfig.HttpHeaderName.toLowerCase()).toBe('access-control-request-method');
        return requestedMethod !== undefined && condition.HttpHeaderConfig.Values
          .some((value: string) => value.toLowerCase() === requestedMethod.toLowerCase());
      }
      throw new Error(`해석하지 않은 ALB 조건: ${condition.Field}`);
    }));
    return rule ? owners.get(rule.Actions[0].TargetGroupArn.Ref) : undefined;
  };
  return { template, runtimeRules, evaluate };
}

describe('dev ECS/EKS 공유 앱 라우팅', () => {
  const { template, runtimeRules, evaluate } = buildRoutingFixture();

  test.each(['Ecs', 'Eks'])('%s는 공개 경로의 모든 허용·미지원 method와 preflight 소유자를 구분한다', (runtime) => {
    const methods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'TRACE'];
    for (const path of new Set(FIXTURES.map((fixture) => fixture.path))) {
      for (const method of methods) {
        const regular = FIXTURES.find((fixture) => fixture.path === path && fixture.method === method);
        const preflight = FIXTURES.find((fixture) => fixture.path === path && fixture.method === method && fixture.cors);
        expect({ path, method, owner: evaluate(runtime, method, path) })
          .toEqual({ path, method, owner: regular?.owner });
        expect({ path, method, owner: evaluate(runtime, 'OPTIONS', path, method) })
          .toEqual({ path, method, owner: preflight?.owner });
      }
      for (const requested of [undefined, '', 'BREW', 'OPTIONS']) {
        expect(evaluate(runtime, 'OPTIONS', path, requested)).toBeUndefined();
      }
    }
  });

  test.each(['Ecs', 'Eks'])('%s는 미등록 경로·빈 parameter·추가 segment·public health를 전달하지 않는다', (runtime) => {
    const invalidPaths = [
      '/api/v1/healthz', '/v1/healthz', '/v1/traces/', '/v1/unknown',
      '/api/v1/auth/login', '/api/v1/auth/authorize', '/api/v1/auth/unknown', '/api/v1/auth/me/extra',
      '/api/v1/auth/oidc/callback/', '/api/v1/auth/oidc/callback/google/extra',
      '/api/v1/organizations', '/api/v1/organizations/', '/api/v1/organizations//teams',
      '/api/v1/organizations/org-1/unknown', '/api/v1/organizations/org-1/teams/extra/deeper',
      '/api/v1/organizations/org-1/analytics/teams//users',
      '/api/v1/organizations/org-1/members/member-3/seats/extra',
      '/api/v1/organizations/org-1/vendors/vendor-4/connection/verify/extra',
      '/api/v1/organizations/org-1/operations/op-6/targets/target-9/confirm/extra',
      '/api/v1/vendor-catalog/', '/api/v1/vendor-catalog-old',
      '/api/v1/vendor-catalog//plans', '/api/v1/vendor-catalog/vendor-4/plans/extra',
      '/api/v1/invitations-old', '/api/v1/installations/unknown',
      '/windows/extra', '/unix/extra', '/bin', '/bin/', '/bin/parent/child',
    ];
    for (const path of invalidPaths) {
      for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD']) {
        expect({ path, method, owner: evaluate(runtime, method, path) }).toEqual({ path, method, owner: undefined });
        expect({ path, method, owner: evaluate(runtime, 'OPTIONS', path, method) }).toEqual({ path, method, owner: undefined });
      }
    }
  });

  test('공유 URI의 OPTIONS는 요청 method header로 소유자를 고르고 일반 GET은 실제 method를 사용한다', () => {
    expect(evaluate('Ecs', 'OPTIONS', `${ORGANIZATION}/teams`, 'GET')).toBe('dashboard');
    expect(evaluate('Ecs', 'OPTIONS', `${ORGANIZATION}/teams`, 'POST')).toBe('enrollment');
    expect(evaluate('Ecs', 'GET', `${ORGANIZATION}/teams`, 'POST')).toBe('dashboard');
    expect(evaluate('Ecs', 'OPTIONS', `${ORGANIZATION}/vendors/vendor-4`, 'PATCH')).toBe('enrollment');
    expect(evaluate('Ecs', 'OPTIONS', `${ORGANIZATION}/vendors/vendor-4`, 'DELETE')).toBe('enrollment');
    expect(evaluate('Ecs', 'OPTIONS', `${ORGANIZATION}/vendors/vendor-4`, 'PUT')).toBeUndefined();
  });

  test('OTLP는 priority 1의 정확한 세 경로와 기존 method 동작을 유지한다', () => {
    for (const runtime of ['Ecs', 'Eks']) {
      const first = runtimeRules(runtime)[0];
      expect(first.Priority).toBe(1);
      expect(first.Conditions).toEqual([{
        Field: 'path-pattern', PathPatternConfig: { Values: ['/v1/traces', '/v1/metrics', '/v1/logs'] },
      }]);
      for (const path of ['/v1/traces', '/v1/metrics', '/v1/logs']) {
        for (const method of ['POST', 'GET', 'OPTIONS']) expect(evaluate(runtime, method, path)).toBe('ingest');
      }
    }
  });

  test('조건당 평가 3개·규칙당 평가 5개·ALB당 규칙 100개와 regex 길이 128자 안에 든다', () => {
    for (const runtime of ['Ecs', 'Eks']) {
      const rules = runtimeRules(runtime);
      expect(rules.length).toBeLessThanOrEqual(100);
      expect(new Set(rules.map((rule) => rule.Priority)).size).toBe(rules.length);
      for (const rule of rules) {
        let total = 0;
        for (const condition of rule.Conditions) {
          const config = condition.PathPatternConfig ?? condition.HttpRequestMethodConfig ?? condition.HttpHeaderConfig;
          const values: string[] = config.RegexValues ?? config.Values;
          expect(values.length).toBeLessThanOrEqual(3);
          values.forEach((value) => expect(value.length).toBeLessThanOrEqual(128));
          total += values.length;
        }
        expect(total).toBeLessThanOrEqual(5);
      }
    }
  });

  test('두 listener의 default는 404이며 전달 규칙은 runtime별 독립 TG를 사용한다', () => {
    const listeners = Object.values(template.findResources('AWS::ElasticLoadBalancingV2::Listener')) as any[];
    listeners.forEach((listener) => expect(listener.Properties.DefaultActions[0].FixedResponseConfig.StatusCode).toBe('404'));
    const refs = (runtime: string) => new Set(runtimeRules(runtime).map((rule) => rule.Actions[0].TargetGroupArn.Ref));
    expect([...refs('Ecs')].some((ref) => refs('Eks').has(ref))).toBe(false);
    expect(refs('Ecs').size).toBe(3);
    expect(refs('Eks').size).toBe(3);
  });

  test('WAF 추가 범위는 기존 org prefix 밖의 명시 vendor-catalog URI다', () => {
    expect(DEV_DASHBOARD_WAF_EXACT_PATHS).toEqual(['/api/v1/vendor-catalog']);
    expect(DEV_DASHBOARD_WAF_REGEX_PATHS).toEqual(['^/api/v1/vendor-catalog/[^/]+/plans$']);
    const child = new RegExp(DEV_DASHBOARD_WAF_REGEX_PATHS[0]);
    expect(child.test('/api/v1/vendor-catalog/vendor-4/plans')).toBe(true);
    for (const path of ['/api/v1/vendor-catalog//plans', '/api/v1/vendor-catalog/vendor-4/plans/extra']) {
      expect(child.test(path)).toBe(false);
    }
  });
});
