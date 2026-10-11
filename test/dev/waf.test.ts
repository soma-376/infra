import { Template } from 'aws-cdk-lib/assertions';
import { buildApp, buildCicdApp, buildDevApp, MODE_A_EDGE } from '../helpers';

type Statement = Record<string, any>;
type PathKind = 'otlp' | 'enrollment' | 'application' | 'bootstrap' | 'other';
type ContentRule = readonly [name: string, label: string];

// ADR-0027의 규칙 이름과 label을 구현 상수와 독립적으로 고정한다. 이 테스트는
// AWS 관리형 탐지 signature를 실행하지 않으며, 해당 label이 이미 붙은 요청에
// 합성된 사용자 정의 조건이 어떻게 적용되는지만 검증한다.
const COMMON_CONTENT_RULES: readonly ContentRule[] = [
  [
    'EC2MetaDataSSRF_BODY',
    'awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_Body',
  ],
  ['GenericLFI_BODY', 'awswaf:managed:aws:core-rule-set:GenericLFI_Body'],
  ['GenericRFI_BODY', 'awswaf:managed:aws:core-rule-set:GenericRFI_Body'],
  [
    'CrossSiteScripting_BODY',
    'awswaf:managed:aws:core-rule-set:CrossSiteScripting_Body',
  ],
  [
    'EC2MetaDataSSRF_QUERYARGUMENTS',
    'awswaf:managed:aws:core-rule-set:EC2MetaDataSSRF_QueryArguments',
  ],
  [
    'GenericLFI_QUERYARGUMENTS',
    'awswaf:managed:aws:core-rule-set:GenericLFI_QueryArguments',
  ],
  [
    'RestrictedExtensions_QUERYARGUMENTS',
    'awswaf:managed:aws:core-rule-set:RestrictedExtensions_QueryArguments',
  ],
  [
    'GenericRFI_QUERYARGUMENTS',
    'awswaf:managed:aws:core-rule-set:GenericRFI_QueryArguments',
  ],
  [
    'CrossSiteScripting_QUERYARGUMENTS',
    'awswaf:managed:aws:core-rule-set:CrossSiteScripting_QueryArguments',
  ],
];
const KNOWN_BAD_CONTENT_RULES: readonly ContentRule[] = [
  [
    'JavaDeserializationRCE_BODY',
    'awswaf:managed:aws:known-bad-inputs:JavaDeserializationRCE_Body',
  ],
  ['Log4JRCE_BODY', 'awswaf:managed:aws:known-bad-inputs:Log4JRCE_Body'],
  ['ReactJSRCE_BODY', 'awswaf:managed:aws:known-bad-inputs:ReactJSRCE_Body'],
  [
    'JavaDeserializationRCE_QUERYSTRING',
    'awswaf:managed:aws:known-bad-inputs:JavaDeserializationRCE_QueryString',
  ],
  [
    'Log4JRCE_QUERYSTRING',
    'awswaf:managed:aws:known-bad-inputs:Log4JRCE_QueryString',
  ],
];
const SQL_CONTENT_RULES: readonly ContentRule[] = [
  ['SQLi_BODY', 'awswaf:managed:aws:sql-database:SQLi_Body'],
  [
    'SQLiExtendedPatterns_BODY',
    'awswaf:managed:aws:sql-database:SQLiExtendedPatterns_Body',
  ],
  ['SQLi_QUERYARGUMENTS', 'awswaf:managed:aws:sql-database:SQLi_QueryArguments'],
  [
    'SQLiExtendedPatterns_QUERYARGUMENTS',
    'awswaf:managed:aws:sql-database:SQLiExtendedPatterns_QueryArguments',
  ],
];
const CONTENT_RULES = [
  ...COMMON_CONTENT_RULES,
  ...KNOWN_BAD_CONTENT_RULES,
  ...SQL_CONTENT_RULES,
];
const BODY_RULES = CONTENT_RULES.filter(([name]) => name.endsWith('_BODY'));
const QUERY_RULES = CONTENT_RULES.filter(([name]) => name.includes('_QUERY'));
const RESTRICTED_EXTENSION_LABEL =
  'awswaf:managed:aws:core-rule-set:RestrictedExtensions_URIPath';
const GLOBAL_COUNT_LABELS = [
  'awswaf:managed:aws:core-rule-set:NoUserAgent_Header',
  'awswaf:managed:aws:core-rule-set:SizeRestrictions_QueryString',
  'awswaf:managed:aws:core-rule-set:SizeRestrictions_Cookie_Header',
  'awswaf:managed:aws:core-rule-set:SizeRestrictions_Body',
  'awswaf:managed:aws:core-rule-set:SizeRestrictions_URIPath',
  'awswaf:managed:aws:amazon-ip-list:AWSManagedReconnaissanceList',
  'awswaf:managed:aws:amazon-ip-list:AWSManagedIPDDoSList',
  'awswaf:managed:aws:anonymous-ip-list:AnonymousIPList',
  'awswaf:managed:aws:anonymous-ip-list:HostingProviderIPList',
];

const PATH_CASES: readonly (readonly [path: string, kind: PathKind])[] = [
  ['/v1/traces', 'otlp'],
  ['/v1/metrics', 'otlp'],
  ['/v1/logs', 'otlp'],
  ['/api/v1/enroll', 'enrollment'],
  ['/api/v1/installations/', 'enrollment'],
  ['/api/v1/installations/id/telemetry-token', 'enrollment'],
  ['/api/v1/invitations', 'enrollment'],
  ['/api/v1/invitations/one', 'enrollment'],
  ['/api/v1/invitations-old', 'enrollment'],
  ['/api/v1/auth/', 'application'],
  ['/api/v1/auth/login', 'application'],
  ['/api/v1/auth/cli/authorize', 'application'],
  ['/api/v1/manifest', 'application'],
  ['/api/v1/organizations/', 'application'],
  ['/api/v1/organizations/id/teams', 'application'],
  ['/api/v1/inquiries', 'application'],
  ['/api/v1/check-updates', 'application'],
  ['/windows', 'bootstrap'],
  ['/unix', 'bootstrap'],
  ['/bin/', 'bootstrap'],
  ['/bin/windows/tool.exe', 'bootstrap'],
  ['/bin/tool.log', 'bootstrap'],
  ['/', 'other'],
  ['/ping', 'other'],
  ['/unknown', 'other'],
  ['/v1/healthz', 'other'],
  ['/api/v1/healthz', 'other'],
  ['/api/v1/traces', 'other'],
  ['/api/test', 'other'],
  ['/v1/traces/', 'other'],
  ['/v1/traces-old', 'other'],
  ['/v1/metrics/child', 'other'],
  ['/v1/logs-extra', 'other'],
  ['/V1/traces', 'other'],
  ['/v1/enrollment', 'other'],
  ['/v1/enroll', 'other'],
  ['/v1/installations/id/telemetry-token', 'other'],
  ['/v1/invitations', 'other'],
  ['/v1/invitations-old', 'other'],
  ['/v1/auth/login', 'other'],
  ['/api/v1/enroll/', 'other'],
  ['/api/v1/enrollment', 'other'],
  ['/api/v1/installations', 'other'],
  ['/api/v1/installations-old/one', 'other'],
  ['/api/v1/auth', 'other'],
  ['/api/v1/auth-old/login', 'other'],
  ['/api/v1/manifest/', 'other'],
  ['/api/v1/manifest/child', 'other'],
  ['/api/v1/manifest-old', 'other'],
  ['/api/v1/organizations', 'other'],
  ['/api/v1/organizations-old/one', 'other'],
  ['/api/v1/inquiries/', 'other'],
  ['/api/v1/inquiries/child', 'other'],
  ['/api/v1/inquiries-old', 'other'],
  ['/api/v1/check-updates/', 'other'],
  ['/api/v1/check-updates/child', 'other'],
  ['/api/v1/check-updates-old', 'other'],
  ['/API/v1/manifest', 'other'],
  ['/api/v1/unknown', 'other'],
  ['/v1/installations', 'other'],
  ['/v1/installations-old/one', 'other'],
  ['/windows/', 'other'],
  ['/windows.exe', 'other'],
  ['/unix/', 'other'],
  ['/bin', 'other'],
  ['/binx/tool.exe', 'other'],
  ['/binary/tool.exe', 'other'],
];

const EXPECTED_RULE_PRIORITIES: readonly (
  readonly [name: string, priority: number]
)[] = [
  ['GeoBlock', 0],
  ['AmazonIpReputation', 10],
  ['AnonymousIpList', 20],
  ['OtlpRateCount', 30],
  ['EnrollmentRateBlock', 40],
  ['RemainingRateBlock', 50],
  ['CommonRules', 60],
  ['KnownBadInputs', 70],
  ['SqlInjection', 80],
  ['AppBodyLabelBlock', 90],
  ['AppQueryLabelBlock', 100],
  ['RestrictedExtensionsOutsideBinBlock', 110],
];

// 합성된 사용자 정의 statement의 제한된 평가기. 탐지기·국가·IP 평판·rate 상태를
// 모사하지 않는다. 미지원 statement는 false로 놓치지 않고 즉시 실패시킨다.
// UriPath NONE 조건만 평가하며 실제 ALB URI 정규화와의 동치를 증명하지 않는다.
function matchesCustomStatement(
  statement: Statement,
  uriPath: string,
  labels: readonly string[] = [],
): boolean {
  expect(Object.keys(statement)).toHaveLength(1);
  if (statement.AndStatement) {
    return statement.AndStatement.Statements.every((child: Statement) =>
      matchesCustomStatement(child, uriPath, labels),
    );
  }
  if (statement.OrStatement) {
    return statement.OrStatement.Statements.some((child: Statement) =>
      matchesCustomStatement(child, uriPath, labels),
    );
  }
  if (statement.NotStatement) {
    return !matchesCustomStatement(
      statement.NotStatement.Statement,
      uriPath,
      labels,
    );
  }
  if (statement.LabelMatchStatement) {
    expect(statement.LabelMatchStatement.Scope).toBe('LABEL');
    return labels.includes(statement.LabelMatchStatement.Key);
  }
  if (statement.ByteMatchStatement) {
    const match = statement.ByteMatchStatement;
    expect(match.FieldToMatch).toEqual({ UriPath: {} });
    expect(match.TextTransformations).toEqual([{ Priority: 0, Type: 'NONE' }]);
    if (match.PositionalConstraint === 'EXACTLY') {
      return uriPath === match.SearchString;
    }
    if (match.PositionalConstraint === 'STARTS_WITH') {
      return uriPath.startsWith(match.SearchString);
    }
  }
  throw new Error(`검증하지 않는 사용자 정의 statement: ${JSON.stringify(statement)}`);
}

function visitStatements(
  statement: Statement,
  visit: (value: Statement) => void,
): void {
  visit(statement);
  const children = statement.AndStatement?.Statements
    ?? statement.OrStatement?.Statements
    ?? [];
  for (const child of children) {
    visitStatements(child, visit);
  }
  if (statement.NotStatement) {
    visitStatements(statement.NotStatement.Statement, visit);
  }
  const scopeDown = statement.RateBasedStatement?.ScopeDownStatement
    ?? statement.ManagedRuleGroupStatement?.ScopeDownStatement;
  if (scopeDown) {
    visitStatements(scopeDown, visit);
  }
}

function labelKeys(statement: Statement): string[] {
  const keys: string[] = [];
  visitStatements(statement, (value) => {
    if (value.LabelMatchStatement) {
      expect(value.LabelMatchStatement.Scope).toBe('LABEL');
      keys.push(value.LabelMatchStatement.Key);
    }
  });
  return keys;
}

describe('dev ALB WAF 정책 합성', () => {
  const { edge } = buildDevApp();
  const template = Template.fromStack(edge);
  const webAcl = (): any => {
    const resources = Object.values(template.findResources('AWS::WAFv2::WebACL'));
    expect(resources).toHaveLength(1);
    return resources[0];
  };
  const rules = (): any[] => webAcl().Properties.Rules;
  const rule = (name: string): any => {
    const found = rules().filter((value) => value.Name === name);
    expect(found).toHaveLength(1);
    return found[0];
  };
  const loggingConfig = (): any => {
    const resources = Object.values(
      template.findResources('AWS::WAFv2::LoggingConfiguration'),
    );
    expect(resources).toHaveLength(1);
    return resources[0];
  };
  const labelBlockRules = (): any[] => [
    rule('AppBodyLabelBlock'),
    rule('AppQueryLabelBlock'),
    rule('RestrictedExtensionsOutsideBinBlock'),
  ];
  const anyLabelBlock = (path: string, labels: readonly string[]): boolean =>
    labelBlockRules().some((value) =>
      matchesCustomStatement(value.Statement, path, labels),
    );

  test('기본 Allow의 REGIONAL Web ACL 하나를 기존 ALB ARN에 연결한다', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 1);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    expect(webAcl().Properties).toMatchObject({
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
    });
    const [albId] = Object.keys(
      template.findResources('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    );
    const [webAclId] = Object.keys(template.findResources('AWS::WAFv2::WebACL'));
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: { Ref: albId },
      WebACLArn: { 'Fn::GetAtt': [webAclId, 'Arn'] },
    });
  });

  test('PR #18의 ALB 공개 경로와 WAF 앱 분류가 canonical·prefix 경계에서 일치한다', () => {
    const publicPaths: string[] = Object.values(template.findResources(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
    )).flatMap((value: any) => value.Properties.Conditions
      .flatMap((condition: any) => condition.PathPatternConfig?.Values ?? []));
    for (const [path, kind] of PATH_CASES) {
      const forwarded = publicPaths.some((pattern) => pattern.endsWith('*')
        ? path.startsWith(pattern.slice(0, -1))
        : path === pattern);
      expect(forwarded).toBe(kind !== 'other');
      expect(matchesCustomStatement(
        rule('AppQueryLabelBlock').Statement, path, [QUERY_RULES[0][1]],
      )).toBe(forwarded);
    }
  });

  test('국가·IP·rate·관리형 그룹·label Block 순서를 유일한 priority로 고정한다', () => {
    expect(rules().map((value) => [value.Name, value.Priority]))
      .toEqual(EXPECTED_RULE_PRIORITIES);
    expect(new Set(rules().map((value) => value.Priority)).size)
      .toBe(rules().length);
    for (const value of [...rules(), webAcl().Properties]) {
      expect(value.VisibilityConfig).toMatchObject({
        CloudWatchMetricsEnabled: true,
        SampledRequestsEnabled: false,
      });
      expect(value.VisibilityConfig.MetricName).toEqual(expect.any(String));
      expect(value.VisibilityConfig.MetricName.length).toBeGreaterThan(0);
    }
  });

  test('CN·RU·KP·IR를 source IP 국가로 차단하며 Host 또는 path의 전면 Allow가 없다', () => {
    expect(rule('GeoBlock').Action).toEqual({ Block: {} });
    const geo = rule('GeoBlock').Statement.GeoMatchStatement;
    expect([...geo.CountryCodes].sort()).toEqual(['CN', 'IR', 'KP', 'RU']);
    expect(geo.ForwardedIPConfig).toBeUndefined();
    for (const value of rules()) {
      expect(value.Action?.Allow).toBeUndefined();
      visitStatements(value.Statement, (statement) => {
        if (statement.ByteMatchStatement) {
          expect(statement.ByteMatchStatement.FieldToMatch).toEqual({ UriPath: {} });
          expect(statement.ByteMatchStatement.TextTransformations).toEqual([
            { Priority: 0, Type: 'NONE' },
          ]);
        }
      });
    }
  });

  test.each([
    {
      ruleName: 'CommonRules',
      name: 'AWSManagedRulesCommonRuleSet',
      version: 'Version_1.23',
      overrides: [
        'NoUserAgent_HEADER',
        'SizeRestrictions_QUERYSTRING',
        'SizeRestrictions_Cookie_HEADER',
        'SizeRestrictions_BODY',
        'SizeRestrictions_URIPATH',
        'RestrictedExtensions_URIPATH',
        ...COMMON_CONTENT_RULES.map(([name]) => name),
      ],
    },
    {
      ruleName: 'KnownBadInputs',
      name: 'AWSManagedRulesKnownBadInputsRuleSet',
      version: 'Version_1.26',
      overrides: KNOWN_BAD_CONTENT_RULES.map(([name]) => name),
    },
    {
      ruleName: 'SqlInjection',
      name: 'AWSManagedRulesSQLiRuleSet',
      version: 'Version_2.4',
      overrides: SQL_CONTENT_RULES.map(([name]) => name),
    },
    {
      ruleName: 'AmazonIpReputation',
      name: 'AWSManagedRulesAmazonIpReputationList',
      version: undefined,
      overrides: ['AWSManagedReconnaissanceList', 'AWSManagedIPDDoSList'],
    },
    {
      ruleName: 'AnonymousIpList',
      name: 'AWSManagedRulesAnonymousIpList',
      version: undefined,
      overrides: ['AnonymousIPList', 'HostingProviderIPList'],
    },
  ])('$name는 정확한 버전·개별 Count 이름과 그룹 None을 유지한다', (expected) => {
    const value = rule(expected.ruleName);
    expect(value.OverrideAction).toEqual({ None: {} });
    expect(value.Action).toBeUndefined();
    const group = value.Statement.ManagedRuleGroupStatement;
    expect(group.Name).toBe(expected.name);
    expect(group.VendorName).toBe('AWS');
    expect(group.Version).toBe(expected.version);
    expect(group.ScopeDownStatement).toBeUndefined();
    expect(group.ExcludedRules).toBeUndefined();
    const names = group.RuleActionOverrides.map(
      (override: any) => override.Name,
    );
    expect([...names].sort()).toEqual([...expected.overrides].sort());
    expect(new Set(names).size).toBe(names.length);
    for (const override of group.RuleActionOverrides) {
      expect(override.ActionToUse).toEqual({ Count: {} });
    }
  });

  test('본문 9개·query 9개·확장자 1개만 exact label로 후속 Block한다', () => {
    expect(BODY_RULES).toHaveLength(9);
    expect(QUERY_RULES).toHaveLength(9);
    expect(labelKeys(rule('AppBodyLabelBlock').Statement).sort())
      .toEqual(BODY_RULES.map(([, label]) => label).sort());
    expect(labelKeys(rule('AppQueryLabelBlock').Statement).sort())
      .toEqual(QUERY_RULES.map(([, label]) => label).sort());
    expect(labelKeys(rule('RestrictedExtensionsOutsideBinBlock').Statement))
      .toEqual([RESTRICTED_EXTENSION_LABEL]);
    for (const value of labelBlockRules()) {
      expect(value.Action).toEqual({ Block: {} });
    }
  });

  test.each(BODY_RULES)(
    '%s 본문 label은 앱에서만 Block하고 OTLP·비앱에서는 Count를 보존한다',
    (_name, label) => {
      for (const [path, kind] of PATH_CASES) {
        expect(matchesCustomStatement(
          rule('AppBodyLabelBlock').Statement, path, [label],
        )).toBe(kind === 'enrollment' || kind === 'application' || kind === 'bootstrap');
        expect(matchesCustomStatement(
          rule('AppQueryLabelBlock').Statement, path, [label],
        )).toBe(false);
      }
    },
  );

  test.each(QUERY_RULES)(
    '%s query label은 OTLP 포함 앱에서 Block하고 비앱에서는 Count를 보존한다',
    (_name, label) => {
      for (const [path, kind] of PATH_CASES) {
        expect(matchesCustomStatement(
          rule('AppQueryLabelBlock').Statement, path, [label],
        )).toBe(kind !== 'other');
        expect(matchesCustomStatement(
          rule('AppBodyLabelBlock').Statement, path, [label],
        )).toBe(false);
      }
    },
  );

  test('본문 Count와 query label이 함께 있으면 OTLP의 query Block을 건너뛰지 않는다', () => {
    for (const path of ['/v1/traces', '/v1/metrics', '/v1/logs']) {
      expect(anyLabelBlock(path, [BODY_RULES[0][1], QUERY_RULES[0][1]])).toBe(true);
    }
  });

  test.each([
    ['/bin/tool.exe', false],
    ['/bin/sub/tool.log', false],
    ['/bin/', false],
    ['/bin', true],
    ['/other/tool.exe', true],
    ['/bin.exe', true],
    ['/binx/tool.exe', true],
    ['/BIN/tool.exe', true],
  ] as const)('%s는 /bin/ URI 확장자 예외만 적용한다', (path, blocks) => {
    expect(matchesCustomStatement(
      rule('RestrictedExtensionsOutsideBinBlock').Statement,
      path,
      [RESTRICTED_EXTENSION_LABEL],
    )).toBe(blocks);
  });

  test('바이너리 경로의 본문·query는 URI 확장자 Count 예외와 독립적으로 차단한다', () => {
    for (const [, label] of CONTENT_RULES) {
      expect(anyLabelBlock('/bin/tool.exe', [
        RESTRICTED_EXTENSION_LABEL, label,
      ])).toBe(true);
    }
  });

  test('label 없는 요청과 전역 Count label은 후속 Block 없이 기본 Allow를 유지한다', () => {
    expect(webAcl().Properties.DefaultAction).toEqual({ Allow: {} });
    for (const [path] of PATH_CASES) {
      expect(anyLabelBlock(path, [])).toBe(false);
      expect(anyLabelBlock(path, GLOBAL_COUNT_LABELS)).toBe(false);
      expect(anyLabelBlock(path, [
        'awswaf:managed:aws:core-rule-set:GenericLFI_Body-extra',
      ])).toBe(false);
      expect(anyLabelBlock(path, ['GenericLFI_Body'])).toBe(false);
    }
  });

  test('세 rate 규칙은 source IP·300초·고정 초기값과 429 응답을 사용한다', () => {
    const expectedRates = [
      ['OtlpRateCount', 10000],
      ['EnrollmentRateBlock', 300],
      ['RemainingRateBlock', 1000],
    ] as const;
    for (const [name, limit] of expectedRates) {
      const value = rule(name);
      const rate = value.Statement.RateBasedStatement;
      expect(rate).toMatchObject({
        AggregateKeyType: 'IP', EvaluationWindowSec: 300, Limit: limit,
      });
      expect(rate.ForwardedIPConfig).toBeUndefined();
      expect(rate.CustomKeys).toBeUndefined();
      expect(rate.ScopeDownStatement).toBeDefined();
      if (name === 'OtlpRateCount') {
        expect(value.Action).toEqual({ Count: {} });
      } else {
        expect(value.Action).toEqual({
          Block: {
            CustomResponse: {
              ResponseCode: 429,
              ResponseHeaders: [{ Name: 'Retry-After', Value: '60' }],
            },
          },
        });
      }
    }
  });

  // AWS의 보편적인 OR 중첩 금지를 가정하는 검사가 아니다. Remaining 분류의
  // 불필요한 OR 중첩이 돌아오지 않도록 프로젝트가 선택한 평탄한 정규형을 고정한다.
  test('나머지 rate 범위는 NOT 안의 단일 OR와 정확한 여섯 경로 leaf로 구성한다', () => {
    const expectedPaths: readonly (
      readonly [path: string, constraint: 'EXACTLY' | 'STARTS_WITH']
    )[] = [
      ['/v1/traces', 'EXACTLY'],
      ['/v1/metrics', 'EXACTLY'],
      ['/v1/logs', 'EXACTLY'],
      ['/api/v1/enroll', 'EXACTLY'],
      ['/api/v1/installations/', 'STARTS_WITH'],
      ['/api/v1/invitations', 'STARTS_WITH'],
    ];
    const scopeDown = rule('RemainingRateBlock')
      .Statement.RateBasedStatement.ScopeDownStatement;
    expect(scopeDown).toEqual({
      NotStatement: {
        Statement: {
          OrStatement: {
            Statements: expectedPaths.map(([path, constraint]) => ({
              ByteMatchStatement: {
                FieldToMatch: { UriPath: {} },
                PositionalConstraint: constraint,
                SearchString: path,
                TextTransformations: [{ Priority: 0, Type: 'NONE' }],
              },
            })),
          },
        },
      },
    });
  });

  test('dev WAF 로그 그룹은 14일 보존·DESTROY·기본 암호화로 설정한다', () => {
    const logGroups = Object.values(
      template.findResources('AWS::Logs::LogGroup'),
    ) as any[];
    expect(logGroups).toHaveLength(1);
    expect(logGroups[0].Properties).toMatchObject({
      LogGroupName: 'aws-waf-logs-soma-376-dev',
      RetentionInDays: 14,
    });
    expect(logGroups[0].Properties.KmsKeyId).toBeUndefined();
    expect(logGroups[0].DeletionPolicy).toBe('Delete');
    expect(logGroups[0].UpdateReplacePolicy).toBe('Delete');
  });

  test('logging은 ACL ARN과 wildcard 없는 로그 ARN을 연결하고 로그 그룹 생성에 의존한다', () => {
    const [webAclId] = Object.keys(
      template.findResources('AWS::WAFv2::WebACL'),
    );
    const [logGroupId] = Object.keys(
      template.findResources('AWS::Logs::LogGroup'),
    );
    expect(loggingConfig().Properties.ResourceArn).toEqual({
      'Fn::GetAtt': [webAclId, 'Arn'],
    });
    expect(loggingConfig().Properties.LogDestinationConfigs).toEqual([
      {
        'Fn::Join': ['', [
          'arn:aws:logs:ap-northeast-2:111111111111:log-group:',
          { Ref: logGroupId },
        ]],
      },
    ]);
    expect(loggingConfig().DependsOn).toEqual(
      expect.arrayContaining([logGroupId]),
    );
  });

  test('로그 필터는 기본 DROP이며 Block·Count·개별 Count override 중 하나를 KEEP한다', () => {
    expect(loggingConfig().Properties.LoggingFilter).toEqual({
      DefaultBehavior: 'DROP',
      Filters: [{
        Behavior: 'KEEP',
        Requirement: 'MEETS_ANY',
        Conditions: [
          { ActionCondition: { Action: 'BLOCK' } },
          { ActionCondition: { Action: 'COUNT' } },
          { ActionCondition: { Action: 'EXCLUDED_AS_COUNT' } },
        ],
      }],
    });
  });

  // 로그 전달·실제 민감 필드 비노출은 AWS 배포 후 검증 대상이다. 여기서는
  // redaction과 match/rate 상세를 포함하는 data protection 합성 설정만 고정한다.
  test('세 민감 header와 전체 query를 redaction·data protection으로 보호하도록 설정한다', () => {
    const headers = ['authorization', 'cookie', 'x-admin-token'];
    const redactedFields = loggingConfig().Properties.RedactedFields;
    expect(redactedFields).toHaveLength(4);
    expect(redactedFields).toEqual(expect.arrayContaining([
      ...headers.map((name) => ({ SingleHeader: { Name: name } })),
      { QueryString: {} },
    ]));

    const protections = webAcl().Properties.DataProtectionConfig.DataProtections;
    expect(protections).toHaveLength(2);
    expect(protections.map((value: any) => value.Field.FieldType).sort())
      .toEqual(['QUERY_STRING', 'SINGLE_HEADER']);
    for (const protection of protections) {
      expect(protection).toMatchObject({
        Action: 'SUBSTITUTION',
        ExcludeRuleMatchDetails: false,
        ExcludeRateBasedDetails: false,
      });
      expect(protection.FieldToProtect).toBeUndefined();
      if (protection.Field.FieldType === 'SINGLE_HEADER') {
        expect([...protection.Field.FieldKeys].sort())
          .toEqual([...headers].sort());
      } else {
        expect(protection.Field.FieldKeys).toBeUndefined();
      }
    }
  });

  // rate 동작 시점은 AWS의 근사 판정이며, 이 표는 합성된 ScopeDown의 경로 구분만
  // 검증한다. N+1번째 요청이 429가 된다는 주장이 아니다.
  test.each(PATH_CASES)(
    '%s의 rate 분류는 배타적이며 새 앱 경로·bootstrap은 나머지에 포함된다',
    (path, kind) => {
      const matches = [
        'OtlpRateCount', 'EnrollmentRateBlock', 'RemainingRateBlock',
      ].map((name) => matchesCustomStatement(
        rule(name).Statement.RateBasedStatement.ScopeDownStatement,
        path,
      ));
      expect(matches).toEqual([
        kind === 'otlp',
        kind === 'enrollment',
        kind === 'application' || kind === 'bootstrap' || kind === 'other',
      ]);
      expect(matches.filter(Boolean)).toHaveLength(1);
    },
  );
});

describe('WAF 환경 경계', () => {
  test.each([['prod B', undefined], ['prod A', MODE_A_EDGE]] as const)(
    '%s에는 WAF를 추가하지 않는다',
    (_name, config) => {
      const { edge } = buildApp(config);
      const template = Template.fromStack(edge);
      template.resourceCountIs('AWS::WAFv2::WebACL', 0);
      template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
      template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 0);
    },
  );

  test('cicd에는 WAF를 추가하지 않는다', () => {
    const { deploy } = buildCicdApp();
    const template = Template.fromStack(deploy);
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 0);
  });
});
