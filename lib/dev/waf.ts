import { Construct } from 'constructs';
import { CfnLoggingConfiguration, CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import {
  DEV_BOOTSTRAP_PATHS,
  DEV_ENROLLMENT_API_PATHS,
  DEV_ENROLLMENT_MANAGEMENT_PATHS,
  DEV_ENROLLMENT_REGISTRATION_PATHS,
  DEV_OTLP_PATHS,
  DEV_WAF_BLOCKED_COUNTRIES,
  DEV_WAF_LOG_GROUP_NAME,
  DEV_WAF_MANAGED_RULE_VERSIONS,
  DEV_WAF_RATE_EVALUATION_WINDOW_SECONDS,
  DEV_WAF_RATE_LIMITS,
  DEV_WAF_REDACTED_HEADERS,
  DEV_WAF_RETRY_AFTER_SECONDS,
  DEV_WAF_WEB_ACL_NAME,
} from './config';

export interface DevWafProps {
  readonly loadBalancerArn: string;
}

type Statement = CfnWebACL.StatementProperty;
type RuleLabel = readonly [ruleName: string, labelSuffix: string];

// rule 이름과 label은 대소문자도 계약이며 같은 철자를 쓰지 않을 수 있다.
// 고정 버전의 이름·label 정합은 배포 전 API로 별도 확인한다. (ADR-0027)
const CONTENT_RULES = {
  common: {
    prefix: 'awswaf:managed:aws:core-rule-set:',
    body: [
      ['EC2MetaDataSSRF_BODY', 'EC2MetaDataSSRF_Body'],
      ['GenericLFI_BODY', 'GenericLFI_Body'],
      ['GenericRFI_BODY', 'GenericRFI_Body'],
      ['CrossSiteScripting_BODY', 'CrossSiteScripting_Body'],
    ],
    query: [
      ['EC2MetaDataSSRF_QUERYARGUMENTS', 'EC2MetaDataSSRF_QueryArguments'],
      ['GenericLFI_QUERYARGUMENTS', 'GenericLFI_QueryArguments'],
      ['RestrictedExtensions_QUERYARGUMENTS', 'RestrictedExtensions_QueryArguments'],
      ['GenericRFI_QUERYARGUMENTS', 'GenericRFI_QueryArguments'],
      ['CrossSiteScripting_QUERYARGUMENTS', 'CrossSiteScripting_QueryArguments'],
    ],
  },
  knownBadInputs: {
    prefix: 'awswaf:managed:aws:known-bad-inputs:',
    body: [
      ['JavaDeserializationRCE_BODY', 'JavaDeserializationRCE_Body'],
      ['Log4JRCE_BODY', 'Log4JRCE_Body'],
      ['ReactJSRCE_BODY', 'ReactJSRCE_Body'],
    ],
    query: [
      ['JavaDeserializationRCE_QUERYSTRING', 'JavaDeserializationRCE_QueryString'],
      ['Log4JRCE_QUERYSTRING', 'Log4JRCE_QueryString'],
    ],
  },
  sqlInjection: {
    prefix: 'awswaf:managed:aws:sql-database:',
    body: [
      ['SQLi_BODY', 'SQLi_Body'],
      ['SQLiExtendedPatterns_BODY', 'SQLiExtendedPatterns_Body'],
    ],
    query: [
      ['SQLi_QUERYARGUMENTS', 'SQLi_QueryArguments'],
      ['SQLiExtendedPatterns_QUERYARGUMENTS', 'SQLiExtendedPatterns_QueryArguments'],
    ],
  },
} as const;

/**
 * dev ALB 전용 정책 (ADR-0027). Count는 평가를 계속하므로 OTLP 본문이나 debug SQL의
 * Count 예외가 국가·악성 IP·URI·헤더 등 다른 Block 규칙까지 우회하지 않는다.
 * REGIONAL association은 ALB 전체를 보호하고 ALB를 통과하지 않는 직접 DB 접근은 보호하지 않는다.
 */
export class DevWaf extends Construct {
  /** 후속 로그 설정이 같은 Web ACL을 참조한다. */
  public readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: DevWafProps) {
    super(scope, id);

    this.webAcl = new CfnWebACL(this, 'WebAcl', {
      name: DEV_WAF_WEB_ACL_NAME,
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(DEV_WAF_WEB_ACL_NAME),
      rules: buildRules(),
      // RedactedFields만으로는 Headers 검사의 match 상세 등을 보호하지 못하므로
      // Web ACL에서도 지정 필드를 치환한다. false는 match/rate 상세도 보호한다는 뜻이다.
      // 마스킹과 요청 sampling은 별도 설정이므로 모든 sampling도 끈다.
      // (ADR-0027)
      dataProtectionConfig: {
        dataProtections: [
          {
            action: 'SUBSTITUTION',
            field: { fieldType: 'SINGLE_HEADER', fieldKeys: [...DEV_WAF_REDACTED_HEADERS] },
            excludeRuleMatchDetails: false,
            excludeRateBasedDetails: false,
          },
          {
            action: 'SUBSTITUTION',
            field: { fieldType: 'QUERY_STRING' },
            excludeRuleMatchDetails: false,
            excludeRateBasedDetails: false,
          },
        ],
      },
    });
    new CfnWebACLAssociation(this, 'Association', {
      resourceArn: props.loadBalancerArn,
      webAclArn: this.webAcl.attrArn,
    });
    this.configureLogging();
  }

  private configureLogging(): void {
    const logGroup = new LogGroup(this, 'LogGroup', {
      logGroupName: DEV_WAF_LOG_GROUP_NAME,
      retention: RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
      // 별도 KMS key 없이 CloudWatch Logs 기본 암호화를 사용한다. (ADR-0027)
    });
    const logging = new CfnLoggingConfiguration(this, 'Logging', {
      resourceArn: this.webAcl.attrArn,
      // LogGroup ARN의 :*는 WAF 목적지 ARN에 넣지 않는다. 이름 참조로 ARN을
      // 조립하고 아래에서 로그 그룹의 생성 순서도 명시한다.
      logDestinationConfigs: [Stack.of(this).formatArn({
        service: 'logs',
        resource: 'log-group',
        resourceName: logGroup.logGroupName,
        arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      })],
      // 최종 Allow여도 관리형 개별 Count override 탐지를 남기려면
      // EXCLUDED_AS_COUNT까지 KEEP해야 한다. 탐지 없는 Allow는 DROP한다. (ADR-0027)
      // CDK에서 loggingFilter와 SingleHeader 내부는 any이므로 CFN 대소문자를 직접 쓴다.
      loggingFilter: {
        DefaultBehavior: 'DROP',
        Filters: [{
          Behavior: 'KEEP',
          Requirement: 'MEETS_ANY',
          Conditions: ['BLOCK', 'COUNT', 'EXCLUDED_AS_COUNT'].map((action) => ({
            ActionCondition: { Action: action },
          })),
        }],
      },
      // 로그 redaction은 요청 sampling에 적용되지 않는다. 위 ACL 보호와 모든
      // 규칙의 sampling false도 함께 유지한다. (ADR-0027)
      redactedFields: [
        ...DEV_WAF_REDACTED_HEADERS.map((name) => ({ singleHeader: { Name: name } })),
        { queryString: {} },
      ],
    });
    logging.node.addDependency(logGroup);
  }
}

function buildRules(): CfnWebACL.RuleProperty[] {
  const otlp = paths(DEV_OTLP_PATHS);
  // 등록 rate는 기존 세 조건만 공유한다. 인증·조회·관리 경로는 본문/query Block과
  // 별개로 RemainingRateBlock의 1,000건 범위에 포함한다. (ADR-0027, PROJ-200)
  const enrollment = paths(DEV_ENROLLMENT_REGISTRATION_PATHS);
  const app = paths([
    ...DEV_OTLP_PATHS,
    ...DEV_ENROLLMENT_API_PATHS,
    ...DEV_ENROLLMENT_MANAGEMENT_PATHS,
    ...DEV_BOOTSTRAP_PATHS,
  ]);
  // 제외할 여섯 경로 조건을 OR 하나로 합쳐 불필요한 OR 안의 OR 중첩을 없앤다.
  // 경로·rate 정책은 같으며 서비스 입력 수용 여부는 CheckCapacity로 별도 검증한다. (ADR-0027)
  const remaining = not(paths([...DEV_OTLP_PATHS, ...DEV_ENROLLMENT_REGISTRATION_PATHS]));

  return [
    actionRule(
      'GeoBlock',
      0,
      { geoMatchStatement: { countryCodes: [...DEV_WAF_BLOCKED_COUNTRIES] } },
      { block: {} },
    ),
    // 악성 IP는 기본 Block을 유지하고 정찰·DDoS 목록만 관찰한다.
    managedRule(
      'AmazonIpReputation',
      10,
      'AWSManagedRulesAmazonIpReputationList',
      ['AWSManagedReconnaissanceList', 'AWSManagedIPDDoSList'],
    ),
    // 정상 개발자 VPN·프록시·CI·호스팅 출발지를 고려해 두 목록 모두 Count한다.
    managedRule(
      'AnonymousIpList',
      20,
      'AWSManagedRulesAnonymousIpList',
      ['AnonymousIPList', 'HostingProviderIPList'],
    ),
    rateRule(
      'OtlpRateCount',
      30,
      DEV_WAF_RATE_LIMITS.otlp,
      otlp,
      { count: {} },
    ),
    rateRule(
      'EnrollmentRateBlock',
      40,
      DEV_WAF_RATE_LIMITS.enrollment,
      enrollment,
      rateBlock(),
    ),
    rateRule(
      'RemainingRateBlock',
      50,
      DEV_WAF_RATE_LIMITS.remaining,
      remaining,
      rateBlock(),
    ),
    // 전체 그룹은 None이다. 개별 Count만 후속 exact-label 규칙으로 경로별 Block한다.
    // 크기·User-Agent 부재는 정상 표본 관찰용이며 UserAgent_BadBots_HEADER는 기본 Block이다.
    managedRule(
      'CommonRules',
      60,
      'AWSManagedRulesCommonRuleSet',
      [
        'NoUserAgent_HEADER',
        'SizeRestrictions_QUERYSTRING',
        'SizeRestrictions_Cookie_HEADER',
        'SizeRestrictions_BODY',
        'SizeRestrictions_URIPATH',
        ...ruleNames(CONTENT_RULES.common.body),
        ...ruleNames(CONTENT_RULES.common.query),
        'RestrictedExtensions_URIPATH',
      ],
      DEV_WAF_MANAGED_RULE_VERSIONS.common,
    ),
    managedRule(
      'KnownBadInputs',
      70,
      'AWSManagedRulesKnownBadInputsRuleSet',
      [
        ...ruleNames(CONTENT_RULES.knownBadInputs.body),
        ...ruleNames(CONTENT_RULES.knownBadInputs.query),
      ],
      DEV_WAF_MANAGED_RULE_VERSIONS.knownBadInputs,
    ),
    managedRule(
      'SqlInjection',
      80,
      'AWSManagedRulesSQLiRuleSet',
      [
        ...ruleNames(CONTENT_RULES.sqlInjection.body),
        ...ruleNames(CONTENT_RULES.sqlInjection.query),
      ],
      DEV_WAF_MANAGED_RULE_VERSIONS.sqlInjection,
    ),
    // 정확한 OTLP 본문과 앱 경로 밖 SQL 본문은 Count를 유지한다. ALB 본문 검사는 8KB 한도이며
    // gzip/protobuf·코드·프롬프트의 표현 특성상 앱의 인증·압축 전후 크기·압축 해제·
    // JSON/protobuf 파싱·OTLP 구조 검증을 대신하지 못한다. 앱 검사의 구현 완료나 안전성도 증명하지 않는다.
    actionRule(
      'AppBodyLabelBlock',
      90,
      and([contentLabels('body'), app, not(otlp)]),
      { block: {} },
    ),
    // query는 OTLP를 포함한 앱 경로에서 Block하고 경로 밖 SQL 디버깅에서는 Count한다.
    actionRule(
      'AppQueryLabelBlock',
      100,
      and([contentLabels('query'), app]),
      { block: {} },
    ),
    // Windows 설치 파일의 .exe URI를 위해 확장자 탐지만 /bin/에서 Count한다.
    // /bin/ 밖은 같은 label을 다시 Block하며 /bin/의 다른 공격·geo·rate 검사는 그대로 적용한다.
    actionRule(
      'RestrictedExtensionsOutsideBinBlock',
      110,
      and([
        label(`${CONTENT_RULES.common.prefix}RestrictedExtensions_URIPath`),
        not(path('/bin/*')),
      ]),
      { block: {} },
    ),
  ];
}

/**
 * ALB와 literal exact/말단 wildcard 경로 정의만 공유한다. NONE으로 WAF가 받은 URI 원문을
 * 검사하며 URI decode나 소문자 변환은 추가하지 않는다. ALB URI normalization과의 동치는
 * 미검증이므로 인코딩·dot segment·중복 slash의 분류는 ADR-0027에 따라 배포 전 확인한다.
 * association은 :80/:8123을 구분하지 않으므로 debug listener에서도 앱 URI이면 앱 정책을 적용한다.
 * 조작 가능한 Host 헤더로 전면 Allow하는 우회 경로는 만들지 않는다. (ADR-0027)
 */
function path(pattern: string): Statement {
  const prefix = pattern.endsWith('*');
  return {
    byteMatchStatement: {
      fieldToMatch: { uriPath: {} },
      positionalConstraint: prefix ? 'STARTS_WITH' : 'EXACTLY',
      searchString: prefix ? pattern.slice(0, -1) : pattern,
      textTransformations: [{ priority: 0, type: 'NONE' }],
    },
  };
}

function paths(patterns: readonly string[]): Statement {
  return or(patterns.map(path));
}

function and(statements: Statement[]): Statement {
  return { andStatement: { statements } };
}

function or(statements: Statement[]): Statement {
  return { orStatement: { statements } };
}

function not(statement: Statement): Statement {
  return { notStatement: { statement } };
}

function label(key: string): Statement {
  return { labelMatchStatement: { scope: 'LABEL', key } };
}

function contentLabels(kind: 'body' | 'query'): Statement {
  // namespace 전체를 차단하면 관찰용 크기·IP·User-Agent 예외까지 다시 Block하므로 exact key만 쓴다.
  return or(
    Object.values(CONTENT_RULES).flatMap((group) =>
      group[kind].map(([, suffix]) => label(`${group.prefix}${suffix}`)),
    ),
  );
}

function ruleNames(rules: readonly RuleLabel[]): string[] {
  return rules.map(([name]) => name);
}

function visibility(name: string): CfnWebACL.VisibilityConfigProperty {
  // 로그 redaction은 요청 샘플에 적용되지 않으므로 ACL과 모든 사용자 정의 규칙에서 sampling을 끈다.
  return {
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: false,
    metricName: name,
  };
}

function actionRule(
  name: string,
  priority: number,
  statement: Statement,
  action: CfnWebACL.RuleActionProperty,
): CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    statement,
    action,
    visibilityConfig: visibility(name),
  };
}

function managedRule(
  name: string,
  priority: number,
  groupName: string,
  countRules: readonly string[],
  version?: string,
): CfnWebACL.RuleProperty {
  return {
    name,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name: groupName,
        version,
        ruleActionOverrides: countRules.map((ruleName) => ({
          name: ruleName,
          actionToUse: { count: {} },
        })),
      },
    },
    visibilityConfig: visibility(name),
  };
}

function rateRule(
  name: string,
  priority: number,
  limit: number,
  scopeDownStatement: Statement,
  action: CfnWebACL.RuleActionProperty,
): CfnWebACL.RuleProperty {
  return actionRule(
    name,
    priority,
    {
      rateBasedStatement: {
        aggregateKeyType: 'IP',
        evaluationWindowSec: DEV_WAF_RATE_EVALUATION_WINDOW_SECONDS,
        limit,
        scopeDownStatement,
      },
    },
    action,
  );
}

function rateBlock(): CfnWebACL.RuleActionProperty {
  return {
    block: {
      customResponse: {
        responseCode: 429,
        responseHeaders: [
          { name: 'Retry-After', value: String(DEV_WAF_RETRY_AFTER_SECONDS) },
        ],
      },
    },
  };
}
