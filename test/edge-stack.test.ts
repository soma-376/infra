import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { buildApp, MODE_A_EDGE } from './helpers';

describe('EdgeStack mode A (HTTPS + ALB auth)', () => {
  const { edge } = buildApp(MODE_A_EDGE);
  const template = Template.fromStack(edge);

  test('creates a 443 HTTPS listener', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
    });
  });

  test('rule 1 (/v1/*) uses jwt-validation with a JWKS endpoint', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      {
        Conditions: Match.arrayWith([
          Match.objectLike({
            Field: 'path-pattern',
            PathPatternConfig: { Values: ['/v1/*'] },
          }),
        ]),
        Actions: Match.arrayWith([
          Match.objectLike({
            Type: 'jwt-validation',
            JwtValidationConfig: Match.objectLike({
              JwksEndpoint: Match.anyValue(),
            }),
          }),
        ]),
      },
    );
  });

  test('rule 2 (/api/*) uses authenticate-cognito', () => {
    template.hasResourceProperties(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
      {
        Conditions: Match.arrayWith([
          Match.objectLike({
            Field: 'path-pattern',
            PathPatternConfig: { Values: ['/api/*'] },
          }),
        ]),
        Actions: Match.arrayWith([
          Match.objectLike({ Type: 'authenticate-cognito' }),
        ]),
      },
    );
  });

  test('listener default action returns a fixed 404', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      DefaultActions: Match.arrayWith([
        Match.objectLike({
          Type: 'fixed-response',
          FixedResponseConfig: Match.objectLike({ StatusCode: '404' }),
        }),
      ]),
    });
  });

  test('has an HTTP->HTTPS redirect listener on 80', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: Match.arrayWith([
        Match.objectLike({ Type: 'redirect' }),
      ]),
    });
  });

  test('user pool client generates a secret', () => {
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: true,
    });
  });

  test('CloudFront distribution rewrites 403 to /index.html', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      }),
    });
  });
});

describe('EdgeStack mode B (HTTP fallback, no ALB auth)', () => {
  const { edge } = buildApp();
  const template = Template.fromStack(edge);

  test('creates an 80 HTTP listener and no HTTPS listener', () => {
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
    const listeners = template.findResources(
      'AWS::ElasticLoadBalancingV2::Listener',
      { Properties: { Protocol: 'HTTPS' } },
    );
    expect(Object.keys(listeners)).toHaveLength(0);
  });

  test('no listener rule carries an authentication action', () => {
    const rules = template.findResources(
      'AWS::ElasticLoadBalancingV2::ListenerRule',
    );
    for (const rule of Object.values(rules)) {
      const actions = (rule as any).Properties.Actions as Array<{
        Type: string;
      }>;
      const types = actions.map((a) => a.Type);
      expect(types).not.toContain('jwt-validation');
      expect(types).not.toContain('authenticate-cognito');
      expect(types).not.toContain('authenticate-oidc');
    }
  });

  test('emits the edge-no-auth warning annotation', () => {
    Annotations.fromStack(edge).hasWarning(
      '/EdgeStack',
      Match.stringLikeRegexp('ADR-0008'),
    );
  });
});
