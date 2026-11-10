import { CfnAccessEntry, CfnCluster } from 'aws-cdk-lib/aws-eks';
import { ArnPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { ArnFormat, Duration, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { DELIVERY_CONTRACT as D } from '../common/delivery-contract';
import { DevEksRelay } from './eks-relay';

/** Argo Application 상태를 읽는 전용 identity와 기존 private EKS 연결이다. */
export class DevEksDeliveryObserver extends Construct {
  public readonly role: Role;
  constructor(scope: Construct, id: string, props: { cluster: CfnCluster; relay: DevEksRelay }) {
    super(scope, id);
    const stack = Stack.of(this);
    const arn = (service: string, resource: string, resourceName: string, region?: string) => stack.formatArn({
      service, resource, resourceName, region, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.role = new Role(this, 'Role', {
      roleName: D.observerRoleName, description: 'Read-only dev GitOps EKS observer',
      maxSessionDuration: Duration.hours(1),
      assumedBy: new ArnPrincipal(arn('iam', 'role', D.promotionRoleName, '')),
    });
    this.role.addToPolicy(new PolicyStatement({ actions: ['eks:DescribeCluster'], resources: [props.cluster.attrArn] }));
    new CfnAccessEntry(this, 'Access', { clusterName: props.cluster.ref, principalArn: this.role.roleArn,
      type: 'STANDARD', kubernetesGroups: [D.kubernetesGroup] });
    this.role.addToPolicy(new PolicyStatement({ actions: ['ssm:StartSession'],
      resources: [arn('ec2', 'instance', props.relay.instance.instanceId)],
      conditions: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } } }));
    this.role.addToPolicy(new PolicyStatement({ actions: ['ssm:StartSession'], resources: [arn('ssm', 'document', props.relay.sessionDocument.ref)] }));
    this.role.addToPolicy(new PolicyStatement({ actions: ['ssmmessages:OpenDataChannel', 'ssm:ResumeSession', 'ssm:TerminateSession'],
      resources: [arn('ssm', 'session', '${aws:userid}-*')] }));
  }
}
