import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ISecurityGroup, IVpc } from 'aws-cdk-lib/aws-ec2';
import { DevWaf } from './waf';
import { DevEksValidationEdge } from './eks-validation-edge';
import { DevEdgeConfig } from './edge-config';
import { DevEksOtlpTarget } from './eks-config';

export interface DevEdgeStackProps extends StackProps {
  readonly edge?: DevEdgeConfig;
  readonly vpc: IVpc;
  readonly eksValidationAlbSecurityGroup: ISecurityGroup;
  readonly eksOtlpTarget?: DevEksOtlpTarget;
  readonly dbEndpoint: string;
  readonly dbSecretArn: string;
  readonly tokenHashSecretArn: string;
  readonly adminApiTokenSecretArn: string;
}

/** 기존 EKS ALB·TG와 WAF를 유지하는 dev 전용 Edge. (ADR-0035) */
export class DevEdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: DevEdgeStackProps) {
    super(scope, id, props);

    // construct 경로를 유지해 기존 Web ACL·로그·EKS ALB/TG를 교체하지 않는다.
    const waf = new DevWaf(this, 'DevWaf');
    new DevEksValidationEdge(this, 'EksValidation', {
      vpc: props.vpc,
      securityGroup: props.eksValidationAlbSecurityGroup,
      webAclArn: waf.webAcl.attrArn,
      certificateArn: props.edge?.eksCertificateArn,
      additionalCertificateArn: props.edge?.eksAdditionalCertificateArn,
      httpRedirectEnabled: props.edge?.httpRedirectEnabled,
      otlpTarget: props.eksOtlpTarget,
    });

    // 기존 소비자가 사용하는 공유 데이터 output은 ARN만 그대로 노출한다.
    new CfnOutput(this, 'RdsEndpoint', { value: props.dbEndpoint });
    new CfnOutput(this, 'RdsSecretArn', { value: props.dbSecretArn });
    new CfnOutput(this, 'TokenHashSecretArn', { value: props.tokenHashSecretArn });
    new CfnOutput(this, 'AdminApiTokenSecretArn', { value: props.adminApiTokenSecretArn });
  }
}
