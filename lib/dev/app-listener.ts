import { createHash } from 'node:crypto';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import {
  ApplicationListener, ApplicationListenerCertificate, ApplicationLoadBalancer, ApplicationProtocol, CfnListener, CfnListenerCertificate,
  ListenerAction, ListenerCertificate, SslPolicy,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { PORTS } from '../common/config';

export interface DevAppListenerOptions {
  readonly certificateArn?: string;
  readonly additionalCertificateArns?: readonly string[];
  readonly additionalCertificateLogicalIds?: Readonly<Record<string, string>>;
  readonly httpRedirectEnabled?: boolean;
}

/**
 * listener를 새 construct 아래로 옮기지 않는다. 기존 ID와 ListenerArn을 유지해야
 * 53개 규칙의 교체와 전환 중 규칙 한도 초과를 피할 수 있다. (ADR-0033)
 */
export function addDevAppListener(
  alb: ApplicationLoadBalancer,
  id: string,
  options: DevAppListenerOptions = {},
): ApplicationListener {
  const certificate = options.certificateArn === undefined ? undefined
    : Certificate.fromCertificateArn(alb, `${id}Certificate`, options.certificateArn);
  const listener = alb.addListener(id, {
    port: certificate ? PORTS.https : PORTS.http,
    protocol: certificate ? ApplicationProtocol.HTTPS : ApplicationProtocol.HTTP,
    ...(certificate ? { certificates: [certificate], sslPolicy: SslPolicy.TLS13_RES } : {}),
    // ingress는 NetworkStack에서만 devAllowedCidr에 맞춰 추가한다.
    open: false,
    defaultAction: ListenerAction.fixedResponse(404, { contentType: 'text/plain', messageBody: 'Not Found' }),
  });
  // ARN별 식별자는 배열 재정렬이나 다른 인증서 추가 시 기존 연결의 교체를 막는다.
  for (const arn of [...(options.additionalCertificateArns ?? [])].sort()) {
    const key = createHash('sha256').update(arn).digest('hex');
    const id = `AdditionalCertificate${key}`;
    const binding = new ApplicationListenerCertificate(listener, id, {
      listener, certificates: [ListenerCertificate.fromArn(arn)],
    });
    const existingId = options.additionalCertificateLogicalIds?.[arn];
    if (existingId) {
      // 이미 배포된 연결을 다른 logical ID로 제거·재생성하면 같은 인증서가 분리될 수 있다.
      (binding.node.defaultChild as CfnListenerCertificate).overrideLogicalId(existingId);
    }
  }
  if (certificate && options.httpRedirectEnabled !== false) {
    const redirect = alb.addListener(`${id}Redirect`, {
      port: PORTS.http,
      protocol: ApplicationProtocol.HTTP,
      open: false,
      defaultAction: ListenerAction.redirect({
        protocol: 'HTTPS', port: String(PORTS.https), host: '#{host}',
        path: '/#{path}', query: '#{query}', permanent: true,
      }),
    });
    // 신규 생성 순서를 명시한다. 기존 스택의 전환/복구는 런북의 두 배포로 분리한다.
    (redirect.node.defaultChild as CfnListener).addDependency(listener.node.defaultChild as CfnListener);
  }
  return listener;
}
