import { ArnFormat, RemovalPolicy, Stack } from 'aws-cdk-lib/core';
import { CfnIPSet, CfnLoggingConfiguration, CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { PERF_GATEWAY_HOST, PERF_OTLP_PATHS } from './edge-config';

type Statement = CfnWebACL.StatementProperty;
type RuleLabel = readonly [ruleName: string, labelSuffix: string];
// dev OTLP 정책 스냅샷이다. 변경할 때 동등성 테스트와 ADR-0051을 함께 확인한다.
export const PERF_WAF_VERSIONS = { common: 'Version_1.23', knownBadInputs: 'Version_1.26', sqlInjection: 'Version_2.4' } as const;
const REDACTED_HEADERS = ['authorization', 'cookie', 'x-admin-token'];
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

export interface PerfWafProps { readonly sourceCidrs: readonly string[] }

/** 허용된 NAT 요청도 관리형 규칙을 끝까지 평가한다. source Allow shortcut은 없다. */
export class PerfWaf extends Construct {
  public readonly webAcl: CfnWebACL;
  public readonly logGroup: LogGroup;
  constructor(scope: Construct, id: string, props: PerfWafProps) {
    super(scope, id);
    const sources = new CfnIPSet(this, 'Sources', { scope: 'REGIONAL', ipAddressVersion: 'IPV4', addresses: [...props.sourceCidrs] });
    this.webAcl = new CfnWebACL(this, 'Acl', { name: 'soma-376-perf', scope: 'REGIONAL', defaultAction: { allow: {} },
      visibilityConfig: visibility('soma-376-perf'), rules: perfWafRules(sources.attrArn), dataProtectionConfig: { dataProtections: [
        { action: 'SUBSTITUTION', field: { fieldType: 'SINGLE_HEADER', fieldKeys: REDACTED_HEADERS }, excludeRuleMatchDetails: false, excludeRateBasedDetails: false },
        { action: 'SUBSTITUTION', field: { fieldType: 'QUERY_STRING' }, excludeRuleMatchDetails: false, excludeRateBasedDetails: false },
      ] } });
    this.logGroup = new LogGroup(this, 'Logs', { logGroupName: 'aws-waf-logs-soma-376-perf', retention: RetentionDays.ONE_DAY, removalPolicy: RemovalPolicy.DESTROY });
    const logging = new CfnLoggingConfiguration(this, 'Logging', { resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [Stack.of(this).formatArn({ service: 'logs', resource: 'log-group', resourceName: this.logGroup.logGroupName, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
      loggingFilter: { DefaultBehavior: 'DROP', Filters: [{ Behavior: 'KEEP', Requirement: 'MEETS_ANY', Conditions: ['BLOCK', 'COUNT', 'EXCLUDED_AS_COUNT'].map(action => ({ ActionCondition: { Action: action } })) }] },
      redactedFields: [...REDACTED_HEADERS.map(name => ({ singleHeader: { Name: name } })), { queryString: {} }],
    });
    logging.node.addDependency(this.logGroup);
  }
}

/** dev OTLP 하위 정책을 보존하고 source/host/method/path Block만 추가한다. */
export function perfWafRules(sourceArn: string): CfnWebACL.RuleProperty[] {
  const otlp = or(PERF_OTLP_PATHS.map(path));
  return [
    rule('OutsidePerfNatBlock', 0, not({ ipSetReferenceStatement: { arn: sourceArn } }), { block: {} }),
    rule('UnexpectedHostBlock', 1, not(match({ singleHeader: { Name: 'host' } }, PERF_GATEWAY_HOST, 'LOWERCASE')), { block: {} }),
    rule('UnexpectedMethodBlock', 2, not(match({ method: {} }, 'POST')), { block: {} }),
    rule('UnexpectedPathBlock', 3, not(otlp), { block: {} }),
    rule('GeoBlock', 5, { geoMatchStatement: { countryCodes: ['CN', 'RU', 'KP', 'IR'] } }, { block: {} }),
    managed('AmazonIpReputation', 10, 'AWSManagedRulesAmazonIpReputationList', ['AWSManagedReconnaissanceList', 'AWSManagedIPDDoSList']),
    managed('AnonymousIpList', 20, 'AWSManagedRulesAnonymousIpList', ['AnonymousIPList', 'HostingProviderIPList']),
    rule('OtlpRateCount', 30, { rateBasedStatement: { aggregateKeyType: 'IP', evaluationWindowSec: 300, limit: 10000, scopeDownStatement: otlp } }, { count: {} }),
    managed('CommonRules', 60, 'AWSManagedRulesCommonRuleSet', ['NoUserAgent_HEADER', 'SizeRestrictions_QUERYSTRING', 'SizeRestrictions_Cookie_HEADER', 'SizeRestrictions_BODY', 'SizeRestrictions_URIPATH', ...names(CONTENT_RULES.common.body), ...names(CONTENT_RULES.common.query), 'RestrictedExtensions_URIPATH'], PERF_WAF_VERSIONS.common),
    managed('KnownBadInputs', 70, 'AWSManagedRulesKnownBadInputsRuleSet', [...names(CONTENT_RULES.knownBadInputs.body), ...names(CONTENT_RULES.knownBadInputs.query)], PERF_WAF_VERSIONS.knownBadInputs),
    managed('SqlInjection', 80, 'AWSManagedRulesSQLiRuleSet', [...names(CONTENT_RULES.sqlInjection.body), ...names(CONTENT_RULES.sqlInjection.query)], PERF_WAF_VERSIONS.sqlInjection),
    // dev의 CLI query 예외는 /api/v1/auth/oidc/authorize에만 해당하므로 OTLP에는 없다.
    rule('OtlpQueryLabelBlock', 100, and([otlp, or(Object.values(CONTENT_RULES).flatMap(group => group.query.map(([, suffix]) => label(`${group.prefix}${suffix}`))))]), { block: {} }),
    rule('RestrictedExtensionsOutsideBinBlock', 110, label(`${CONTENT_RULES.common.prefix}RestrictedExtensions_URIPath`), { block: {} }),
  ];
}
function visibility(metricName: string): CfnWebACL.VisibilityConfigProperty { return { cloudWatchMetricsEnabled: true, sampledRequestsEnabled: false, metricName }; }
function rule(name: string, priority: number, statement: Statement, action: CfnWebACL.RuleActionProperty): CfnWebACL.RuleProperty { return { name, priority, statement, action, visibilityConfig: visibility(name) }; }
function managed(name: string, priority: number, groupName: string, countRules: readonly string[], version?: string): CfnWebACL.RuleProperty {
  return { name, priority, overrideAction: { none: {} }, statement: { managedRuleGroupStatement: { vendorName: 'AWS', name: groupName, version, ruleActionOverrides: countRules.map(ruleName => ({ name: ruleName, actionToUse: { count: {} } })) } }, visibilityConfig: visibility(name) };
}
function match(fieldToMatch: CfnWebACL.FieldToMatchProperty, searchString: string, type = 'NONE'): Statement { return { byteMatchStatement: { fieldToMatch, positionalConstraint: 'EXACTLY', searchString, textTransformations: [{ priority: 0, type }] } }; }
function path(value: string): Statement { return match({ uriPath: {} }, value); }
function and(statements: Statement[]): Statement { return { andStatement: { statements } }; }
function or(statements: Statement[]): Statement { return { orStatement: { statements } }; }
function not(statement: Statement): Statement { return { notStatement: { statement } }; }
function label(key: string): Statement { return { labelMatchStatement: { scope: 'LABEL', key } }; }
function names(rules: readonly RuleLabel[]): string[] { return rules.map(([name]) => name); }
