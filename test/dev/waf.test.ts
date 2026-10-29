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
  ['/api/v1/vendor-catalog', 'application'],
  ['/api/v1/vendor-catalog/vendor/plans', 'application'],
  ['/api/v1/vendor-catalog/vendor/plans/extra', 'other'],
  ['/api/v1/vendor-catalog//plans', 'other'],
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
// PCRE 절대 경계와 query decode를 포함한 합성 조건을 평가한다. 실제 AWS signature나
// ALB/servlet parser와의 동치를 증명하지 않으며 서비스 CheckCapacity·live 검증은 별도다.
function matchesCustomStatement(
  statement: Statement,
  uriPath: string,
  labels: readonly string[] = [],
  request: { method?: string; query?: string; body?: string; contentType?: string } = {},
): boolean {
  expect(Object.keys(statement)).toHaveLength(1);
  if (statement.AndStatement) {
    return statement.AndStatement.Statements.every((child: Statement) =>
      matchesCustomStatement(child, uriPath, labels, request),
    );
  }
  if (statement.OrStatement) {
    return statement.OrStatement.Statements.some((child: Statement) =>
      matchesCustomStatement(child, uriPath, labels, request),
    );
  }
  if (statement.NotStatement) {
    return !matchesCustomStatement(
      statement.NotStatement.Statement,
      uriPath,
      labels,
      request,
    );
  }
  if (statement.LabelMatchStatement) {
    expect(statement.LabelMatchStatement.Scope).toBe('LABEL');
    return labels.includes(statement.LabelMatchStatement.Key);
  }
  if (statement.RegexMatchStatement) {
    const match = statement.RegexMatchStatement;
    // JS에는 PCRE \A/\z가 없다. 끝의 개행도 허용하지 않는 절대 경계로 변환한다.
    const pattern = match.RegexString.replaceAll('\\A', '^').replaceAll('\\z', '$(?![\\s\\S])');
    return candidates(match).some(value => new RegExp(pattern).test(value));
  }
  if (statement.ByteMatchStatement) {
    const match = statement.ByteMatchStatement;
    if (match.PositionalConstraint === 'EXACTLY') {
      return candidates(match).some(value => value === match.SearchString);
    }
    if (match.PositionalConstraint === 'STARTS_WITH') {
      return candidates(match).some(value => value.startsWith(match.SearchString));
    }
    if (match.PositionalConstraint === 'CONTAINS') {
      return candidates(match).some(value => value.includes(match.SearchString));
    }
  }
  if (statement.SizeConstraintStatement) {
    const match = statement.SizeConstraintStatement;
    expect(match.ComparisonOperator).toBe('LE');
    return candidates(match).some(value => Buffer.byteLength(value, 'utf8') <= match.Size);
  }
  throw new Error(`검증하지 않는 사용자 정의 statement: ${JSON.stringify(statement)}`);

  function candidates(match: Statement): string[] {
    const field = match.FieldToMatch;
    let values: string[];
    if (field.UriPath) values = [uriPath];
    else if (field.Method) values = [request.method ?? 'GET'];
    else if (field.QueryString) values = [request.query ?? ''];
    else if (field.Body) {
      expect(field.Body.OversizeHandling).toBe('NO_MATCH');
      // ALB의 전체 길이 oversize 신호가 있으면 검사 가능한 prefix로 예외를 열지 않는다.
      values = Buffer.byteLength(request.body ?? '', 'utf8') > 8192 ? [] : [request.body ?? ''];
    } else if (field.SingleHeader) {
      expect(field.SingleHeader.Name).toBe('content-type');
      values = request.contentType === undefined ? [] : [request.contentType];
    } else if (field.SingleQueryArgument) {
      // 단일 query parameter는 중복 값 중 하나가 맞아도 일치한다. 이 의미를 감추지 않는다.
      values = (request.query ?? '').split('&').filter(item =>
        item.split('=', 1)[0].toLowerCase() === field.SingleQueryArgument.Name,
      ).map(item => item.slice(item.indexOf('=') + 1));
    } else throw new Error('미지원 FieldToMatch');
    expect(match.TextTransformations).toHaveLength(1);
    const transformation = match.TextTransformations[0].Type;
    expect(['NONE', 'URL_DECODE', 'LOWERCASE']).toContain(transformation);
    return values.flatMap(value => {
      if (transformation === 'NONE') return [value];
      if (transformation === 'LOWERCASE') return [value.toLowerCase()];
      try { return [decodeURIComponent(field.UriPath ? value : value.replaceAll('+', ' '))]; }
      catch { return []; }
    });
  }
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

  test('기본 Allow의 REGIONAL Web ACL 하나를 기존 EKS ALB ARN에 연결한다', () => {
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

  test('WAF는 기존 넓은 검사 범위를 보존하고 vendor catalog 조회만 추가한다', () => {
    for (const [path, kind] of PATH_CASES) {
      expect(matchesCustomStatement(
        rule('AppQueryLabelBlock').Statement, path, [QUERY_RULES[0][1]],
      )).toBe(kind !== 'other');
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
        if (statement.RegexMatchStatement) {
          const match = statement.RegexMatchStatement;
          if (match.FieldToMatch.QueryString) {
            expect(value.Name).toBe('AppQueryLabelBlock');
            expect(match.TextTransformations).toEqual([{ Priority: 0, Type: 'URL_DECODE' }]);
          } else if (match.FieldToMatch.Body || match.FieldToMatch.SingleHeader) {
            expect(value.Name).toBe('AppBodyLabelBlock');
            expect(match.TextTransformations).toEqual([{ Priority: 0, Type: match.FieldToMatch.Body ? 'NONE' : 'LOWERCASE' }]);
            if (match.FieldToMatch.Body) expect(match.FieldToMatch.Body.OversizeHandling).toBe('NO_MATCH');
          } else {
            expect(match.FieldToMatch).toEqual({ UriPath: {} });
            expect(match.TextTransformations).toEqual([{ Priority: 0, Type: 'NONE' }]);
          }
          expect(match.RegexString.length).toBeLessThanOrEqual(512);
        }
        if (statement.ByteMatchStatement) {
          const field = statement.ByteMatchStatement.FieldToMatch;
          if (!field.UriPath) {
            expect(['AppQueryLabelBlock', 'AppBodyLabelBlock']).toContain(value.Name);
            expect([JSON.stringify({ Method: {} }), JSON.stringify({ QueryString: {} })]).toContain(JSON.stringify(field));
          }
          const isBootstrapRate = ['EnrollmentRateBlock', 'RemainingRateBlock'].includes(value.Name)
            && ['/unix', '/windows'].includes(statement.ByteMatchStatement.SearchString);
          expect(statement.ByteMatchStatement.TextTransformations).toEqual([
            { Priority: 0, Type: isBootstrapRate ? 'URL_DECODE' : 'NONE' },
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

  describe('정상 CLI token JSON의 두 Body label 예외', () => {
    const uri = '/api/v1/auth/cli/token';
    const exceptions = [BODY_RULES[0][1], BODY_RULES[2][1]];
    const values = {
      code: `uac_${'c'.repeat(43)}`,
      redirect_uri: 'http://127.0.0.1:54610/callback',
      code_verifier: 'v'.repeat(64),
    };
    const json = (changes: Record<string, unknown> = {}) => JSON.stringify({ ...values, ...changes });
    const blocks = (body: string, labels = exceptions, options: { method?: string; path?: string; contentType?: string } = {}) => matchesCustomStatement(
      rule('AppBodyLabelBlock').Statement, options.path ?? uri, labels,
      { method: options.method ?? 'POST', contentType: options.contentType ?? 'application/json', body },
    );

    test('필드 순서 6종과 JSON 공백·helper 기본 직렬화는 모두 허용한다', () => {
      const keys = Object.keys(values) as (keyof typeof values)[];
      for (const a of keys) for (const b of keys.filter(k => k !== a)) {
        const c = keys.find(k => k !== a && k !== b)!;
        const ordered = { [a]: values[a], [b]: values[b], [c]: values[c] };
        expect(blocks(JSON.stringify(ordered))).toBe(false);
        expect(blocks(` \t\r\n${JSON.stringify(ordered, null, '\t')}\r\n `)).toBe(false);
      }
      expect(blocks(json().replaceAll(':"', ': "').replaceAll(',"', ', "'))).toBe(false);
      expect(blocks(json(), exceptions, { contentType: 'Application/JSON; Charset=UTF-8' })).toBe(false);
      expect(blocks(json(), exceptions, { contentType: 'application/json ;\tcharset=utf-8' })).toBe(false);
    });

    test.each([
      'http://127.0.0.1:1/callback', 'http://127.0.0.1:65535/callback',
      'http://127.0.0.1:00054610/callback', 'http://[::1]:1/callback',
      'http://[::1]:65535/callback', `http://127.0.0.1:${'0'.repeat(229)}1/callback`,
    ])('정상 콜백 %s의 두 Body label만 제외한다', redirect_uri => {
      expect(blocks(json({ redirect_uri }))).toBe(false);
      for (const label of exceptions) expect(blocks(json({ redirect_uri }), [label])).toBe(false);
    });

    test('PKCE·코드·본문 길이 경계를 지킨다', () => {
      expect(blocks(json({ code_verifier: 'v'.repeat(43) }))).toBe(false);
      expect(blocks(json({ code_verifier: '._~-'.repeat(32), code: `uac_${'_-'.repeat(21)}a` }))).toBe(false);
      expect(blocks(json().padEnd(1024, ' '))).toBe(false);
      expect(blocks(json().padEnd(1025, ' '))).toBe(true);
      expect(blocks(json().padEnd(8192, ' '))).toBe(true);
      expect(blocks(json().padEnd(8193, ' '))).toBe(true);
    });

    test.each([
      'https://127.0.0.1:54610/callback', 'HTTP://127.0.0.1:54610/callback',
      'http://localhost:54610/callback', 'http://127.1:54610/callback',
      'http://169.254.169.254:80/callback', 'http://2130706433:54610/callback',
      'http://127.0.0.1.example.test:54610/callback', 'http://[::ffff:127.0.0.1]:54610/callback',
      'http://127.0.0.1/callback', 'http://127.0.0.1:0/callback',
      'http://127.0.0.1:65536/callback', 'http://127.0.0.1:99999/callback',
      'http://127.0.0.1:-1/callback', 'http://127.0.0.1:+1/callback',
      'http://127.0.0.1:54610/callback/', 'http://127.0.0.1:54610/x/../callback',
      'http://127.0.0.1:54610/%63allback', 'http://user@127.0.0.1:54610/callback',
      'http://127.0.0.1:54610/callback?extra=1', 'http://127.0.0.1:54610/callback#fragment',
      'http://127.0.0.1:54610/callback\n', `http://127.0.0.1:${'0'.repeat(230)}1/callback`,
    ])('잘못된 콜백 %s는 Body 예외가 아니다', redirect_uri => {
      expect(blocks(json({ redirect_uri }))).toBe(true);
    });

    test.each([
      { code: `uac_${'c'.repeat(42)}` }, { code: `uac_${'c'.repeat(44)}` },
      { code: `other_${'c'.repeat(43)}` }, { code: `uac_${'c'.repeat(42)}=` },
      { code_verifier: 'v'.repeat(42) }, { code_verifier: 'v'.repeat(129) },
      { code_verifier: `${'v'.repeat(42)}+` }, { code_verifier: `${'v'.repeat(42)}/` },
      { code_verifier: `${'v'.repeat(42)}=` }, { code_verifier: `${'v'.repeat(42)}\n` },
    ])('code·verifier 형식 오류 %j는 예외가 아니다', changes => {
      expect(blocks(json(changes))).toBe(true);
    });

    test.each(Object.keys(values))('%s 누락·중복·비문자 값은 예외가 아니다', key => {
      const missing: Record<string, unknown> = { ...values };
      delete missing[key];
      expect(blocks(JSON.stringify(missing))).toBe(true);
      for (const duplicate of [values[key as keyof typeof values], 'attacker']) {
        const entry = `"${key}":${JSON.stringify(duplicate)}`;
        expect(blocks(`${json().slice(0, -1)},${entry}}`)).toBe(true);
        expect(blocks(`{${entry},${json().slice(1)}`)).toBe(true);
      }
      for (const value of ['', null, 1, true, [], {}, [values[key as keyof typeof values]]]) {
        expect(blocks(json({ [key]: value }))).toBe(true);
      }
    });

    test.each([
      ['unknown 필드', () => json({ unknown: 'extra' })],
      ['unknown으로 필수 키 대체', () => json().replace('"code":', '"unknown":')],
      ['동일 키 세 개', () => `{${Array(3).fill(`"code":"${values.code}"`).join(',')}}`],
      ['배열 root', () => `[${json()}]`],
      ['따옴표 key 누락', () => json().replace('"code":', 'code:')],
      ['콜론 누락', () => json().replace('"code":', '"code"')],
      ['comma 누락', () => json().replace(',"redirect_uri"', '"redirect_uri"')],
      ['trailing comma', () => `${json().slice(0, -1)},}`],
      ['JSON 주석', () => `${json()}/* comment */`],
      ['잘린 JSON', () => json().slice(0, -1)],
      ['이어 붙인 JSON', () => `${json()}${json()}`],
      ['escaped key', () => json().replace('"code":', '"co\\u0064e":')],
      ['escaped duplicate key', () => `${json().slice(0, -1)},"co\\u0064e":"${values.code}"}`],
      ['escaped slash', () => json().replaceAll('/', '\\/')],
      ['escaped URI 문자', () => json().replace('http:', 'http\\u003a')],
      ['URL encoded URI', () => json({ redirect_uri: encodeURIComponent(values.redirect_uri) })],
      ['문자열 속 JSON 주입', () => json({ code: `${values.code}","unknown":"x` })],
      ['UTF-8 BOM', () => `\ufeff${json()}`],
      ['비JSON 공백', () => `\v${json()}`],
      ['후행 NUL', () => `${json()}\0`],
    ] as const)('%s는 파싱 fallback 없이 예외에서 제외한다', (_name, value) => {
      expect(blocks(value())).toBe(true);
    });

    test('정확한 POST·원문 route·JSON content type에서만 예외다', () => {
      for (const method of ['GET', 'HEAD', 'post', 'PUT']) expect(blocks(json(), exceptions, { method })).toBe(true);
      for (const path of ['/api/v1/auth/token', `${uri}/`, '/api/v1/auth/cli/%74oken']) expect(blocks(json(), exceptions, { path })).toBe(true);
      for (const contentType of ['', 'text/plain', 'application/x-www-form-urlencoded', 'application/json;charset=utf-16', 'application/json; extra=x']) {
        expect(blocks(json(), exceptions, { contentType })).toBe(true);
      }
      expect(matchesCustomStatement(rule('AppBodyLabelBlock').Statement, uri, exceptions, { method: 'POST', body: json() })).toBe(true);
    });

    test('다른 Body·query·URI label과 rate 범위는 유지한다', () => {
      for (const [, label] of BODY_RULES.filter(([, value]) => !exceptions.includes(value))) expect(blocks(json(), [...exceptions, label])).toBe(true);
      for (const [, label] of QUERY_RULES) expect(matchesCustomStatement(rule('AppQueryLabelBlock').Statement, uri, [label], { method: 'POST', body: json() })).toBe(true);
      expect(matchesCustomStatement(rule('RestrictedExtensionsOutsideBinBlock').Statement, uri, [RESTRICTED_EXTENSION_LABEL])).toBe(true);
      expect(matchesCustomStatement(rule('RemainingRateBlock').Statement.RateBasedStatement.ScopeDownStatement, uri)).toBe(true);
      visitStatements(rule('AppBodyLabelBlock').Statement, statement => {
        expect(statement.RegexMatchStatement?.FieldToMatch.JsonBody).toBeUndefined();
        expect(statement.SizeConstraintStatement?.FieldToMatch.JsonBody).toBeUndefined();
        if (statement.SizeConstraintStatement?.FieldToMatch.Body) expect(statement.SizeConstraintStatement).toEqual({
          FieldToMatch: { Body: { OversizeHandling: 'NO_MATCH' } }, ComparisonOperator: 'LE', Size: 1024,
          TextTransformations: [{ Priority: 0, Type: 'NONE' }],
        });
      });
    });
  });

  test('본문 Count와 query label이 함께 있으면 OTLP의 query Block을 건너뛰지 않는다', () => {
    for (const path of ['/v1/traces', '/v1/metrics', '/v1/logs']) {
      expect(anyLabelBlock(path, [BODY_RULES[0][1], QUERY_RULES[0][1]])).toBe(true);
    }
  });

  describe('정상 CLI loopback authorize의 두 query label 예외', () => {
    const uri = '/api/v1/auth/oidc/authorize';
    const exceptions = [QUERY_RULES[0][1], QUERY_RULES[3][1]];
    const parameters = {
      tenant_id: '00000000-0000-4000-8000-000000000001',
      redirect_uri: 'http://127.0.0.1:54610/callback',
      state: 's'.repeat(32),
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    };
    const query = (values: Record<string, string> = {}) => new URLSearchParams({ ...parameters, ...values }).toString();
    const blocks = (value: string, labels = exceptions, path = uri, method = 'GET') => matchesCustomStatement(
      rule('AppQueryLabelBlock').Statement, path, labels, { query: value, method },
    );

    test.each([
      'http://127.0.0.1:1/callback',
      'http://127.0.0.1:65535/callback',
      'http://127.0.0.1:00054610/callback',
      'http://[::1]:54610/callback',
      'http://[::1]:65535/callback',
      `http://127.0.0.1:${'0'.repeat(229)}1/callback`,
    ])('정상 loopback %s는 해당 두 label의 후속 Block만 제외한다', redirect_uri => {
      expect(blocks(query({ redirect_uri }))).toBe(false);
      for (const label of exceptions) expect(blocks(query({ redirect_uri }), [label])).toBe(false);
    });

    test('파라미터 순서·표준 hint·허용된 state와 한 번 인코딩된 값은 유지한다', () => {
      expect(blocks(query({ login_hint: 'person+dev@example.test' }))).toBe(false);
      expect(blocks(query().split('&').reverse().join('&'))).toBe(false);
      expect(blocks(query({ state: 'A._~-0123456789ab', tenant_id: parameters.tenant_id.toUpperCase() }))).toBe(false);
      expect(blocks(query({ state: 's'.repeat(256) }))).toBe(false);
      expect(blocks(query({ login_hint: `${'a'.repeat(241)}@example.test` }))).toBe(false);
    });

    test.each([
      'https://127.0.0.1:54610/callback', 'HTTP://127.0.0.1:54610/callback',
      'http://localhost:54610/callback', 'http://127.1:54610/callback',
      'http://2130706433:54610/callback', 'http://169.254.169.254:80/callback',
      'http://127.0.0.1.example.test:54610/callback', 'http://[::ffff:127.0.0.1]:54610/callback',
      'http://127.0.0.1/callback', 'http://127.0.0.1:0/callback',
      'http://127.0.0.1:65536/callback', 'http://127.0.0.1:99999/callback',
      'http://127.0.0.1:-1/callback', 'http://127.0.0.1:+1/callback',
      'http://127.0.0.1:54610/callback/', 'http://127.0.0.1:54610/other',
      'http://127.0.0.1:54610/x/../callback', 'http://127.0.0.1:54610/%63allback',
      'http://user@127.0.0.1:54610/callback', 'http://127.0.0.1@evil.test:54610/callback',
      'http://127.0.0.1:54610/callback?extra=1', 'http://127.0.0.1:54610/callback#fragment',
      'http://127.0.0.1:54610/callback\n', 'http://127.0.0.1:54610/callback\r\n',
      `http://127.0.0.1:${'0'.repeat(230)}1/callback`,
    ])('잘못된 redirect %s는 예외를 받지 않는다', redirect_uri => {
      expect(blocks(query({ redirect_uri }))).toBe(true);
    });

    test.each(Object.keys(parameters))('%s 누락·중복·빈 값은 예외를 받지 않는다', key => {
      const missing = new URLSearchParams(parameters);
      missing.delete(key);
      expect(blocks(missing.toString())).toBe(true);
      expect(blocks(`${query()}&${key}=${encodeURIComponent(parameters[key as keyof typeof parameters])}`)).toBe(true);
      expect(blocks(query({ [key]: '' }))).toBe(true);
    });

    test.each([
      ['추가 unknown', () => `${query()}&unknown=1`],
      ['빈 항목', () => `${query()}&`],
      ['중복 hint', () => `${query({ login_hint: 'person@example.test' })}&login_hint=other%40example.test`],
      ['중복 redirect와 hint', () => `${query({ login_hint: 'person@example.test' })}&redirect_uri=http%3A%2F%2Fevil.test`],
      ['encoded 구분자로 전체 항목 병합', () => query().replaceAll('&', '%26')],
      ['encoded 구분자로 마지막 항목 병합', () => query().replace('&code_challenge_method=', '%26code_challenge_method=')],
      ['이중 인코딩 구분자', () => query().replaceAll('&', '%2526')],
      ['이중 인코딩 redirect', () => query({ redirect_uri: encodeURIComponent(parameters.redirect_uri) })],
      ['encoded 중복 key', () => `${query()}&redirect%5Furi=http%3A%2F%2Fevil.test`],
      ['대소문자 중복 key', () => `${query()}&REDIRECT_URI=http%3A%2F%2Fevil.test`],
      ['짧은 state', () => query({ state: 's'.repeat(15) })],
      ['긴 state', () => query({ state: 's'.repeat(257) })],
      ['짧은 challenge', () => query({ code_challenge: 'c'.repeat(42) })],
      ['긴 challenge', () => query({ code_challenge: 'c'.repeat(44) })],
      ['challenge padding', () => query({ code_challenge: `${'c'.repeat(42)}=` })],
      ['plain PKCE', () => query({ code_challenge_method: 'plain' })],
      ['비표준 UUID', () => query({ tenant_id: '1-1-1-1-1' })],
      ['hint URL 공격', () => query({ login_hint: 'http://evil.test/x' })],
      ['hint colon 공격', () => query({ login_hint: 'x:y@example.test' })],
      ['hint 줄바꿈', () => query({ login_hint: 'person@example.test\n' })],
      ['hint 길이 초과', () => query({ login_hint: `${'a'.repeat(242)}@example.test` })],
      ['raw plus hint', () => query({ login_hint: 'person+dev@example.test' }).replace('%2B', '+')],
      ['잘못된 percent encoding', () => query().replace('http%3A', 'http%ZZ')],
    ] as const)('%s는 예외를 받지 않는다', (_name, value) => {
      expect(blocks(value())).toBe(true);
    });

    test('정확한 GET·원문 URI에서만 예외가 적용된다', () => {
      for (const method of ['POST', 'HEAD', 'get', 'OPTIONS']) expect(blocks(query(), exceptions, uri, method)).toBe(true);
      for (const path of [`${uri}/`, `${uri}-other`, '/api/v1/auth/oidc/%61uthorize', '/api/v1/auth/oidc/Authorize']) {
        expect(blocks(query(), exceptions, path)).toBe(true);
      }
    });

    test('나머지 query·본문·URI label과 rate 검사를 건너뛰지 않는다', () => {
      for (const [, label] of QUERY_RULES.filter(([, value]) => !exceptions.includes(value))) {
        expect(blocks(query(), [...exceptions, label])).toBe(true);
      }
      for (const [, label] of BODY_RULES) {
        expect(matchesCustomStatement(rule('AppBodyLabelBlock').Statement, uri, [label], { query: query() })).toBe(true);
      }
      expect(matchesCustomStatement(rule('RestrictedExtensionsOutsideBinBlock').Statement, uri, [RESTRICTED_EXTENSION_LABEL], { query: query() })).toBe(true);
      expect(matchesCustomStatement(rule('RemainingRateBlock').Statement.RateBasedStatement.ScopeDownStatement, uri, [], { query: query() })).toBe(true);
    });
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
  test('나머지 rate 범위는 NOT 안의 단일 OR와 정확한 여덟 경로 leaf로 구성한다', () => {
    const expectedPaths: readonly (
      readonly [path: string, constraint: 'EXACTLY' | 'STARTS_WITH']
    )[] = [
      ['/v1/traces', 'EXACTLY'],
      ['/v1/metrics', 'EXACTLY'],
      ['/v1/logs', 'EXACTLY'],
      ['/api/v1/enroll', 'EXACTLY'],
      ['/api/v1/installations/', 'STARTS_WITH'],
      ['/api/v1/invitations', 'STARTS_WITH'],
      ['/unix', 'EXACTLY'],
      ['/windows', 'EXACTLY'],
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
                TextTransformations: [{ Priority: 0, Type: ['/unix', '/windows'].includes(path) ? 'URL_DECODE' : 'NONE' }],
              },
            })),
          },
        },
      },
    });
  });

  test.each(['/%75nix', '/u%6eix', '/%77indows', '/window%73'])(
    'ALB가 bootstrap으로 전달하는 %s는 등록 rate만 소비한다', uri => {
      expect(matchesCustomStatement(rule('EnrollmentRateBlock').Statement.RateBasedStatement.ScopeDownStatement, uri)).toBe(true);
      expect(matchesCustomStatement(rule('RemainingRateBlock').Statement.RateBasedStatement.ScopeDownStatement, uri)).toBe(false);
    },
  );

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
    '%s의 rate 분류는 배타적이며 정확한 bootstrap 두 경로는 등록 예산을 공유한다',
    (path, kind) => {
      const matches = [
        'OtlpRateCount', 'EnrollmentRateBlock', 'RemainingRateBlock',
      ].map((name) => matchesCustomStatement(
        rule(name).Statement.RateBasedStatement.ScopeDownStatement,
        path,
      ));
      expect(matches).toEqual([
        kind === 'otlp',
        kind === 'enrollment' || path === '/unix' || path === '/windows',
        (kind === 'application' || kind === 'bootstrap' || kind === 'other') && path !== '/unix' && path !== '/windows',
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
