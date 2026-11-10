import { CfnCluster, CfnAccessEntry } from 'aws-cdk-lib/aws-eks';
import { ArnPrincipal, PolicyStatement, Role } from 'aws-cdk-lib/aws-iam';
import { ArnFormat, Duration, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { VALUES_SYNC_CONTRACT } from '../common/values-sync-contract';
import { DevEksRelay } from './eks-relay';

interface DevEksValuesReaderProps {
  readonly cluster: CfnCluster;
  readonly relay: DevEksRelay;
}

/** Argo 인계 전 사본 job의 조회 진입점. Kubernetes 권한은 base chart의 제한된 RBAC가 소유한다. */
export class DevEksValuesReader extends Construct {
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: DevEksValuesReaderProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const arn = (service: string, resource: string, resourceName: string) => stack.formatArn({
      service, resource, resourceName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.role = new Role(this, 'Role', {
      roleName: VALUES_SYNC_CONTRACT.readerRoleName,
      assumedBy: new ArnPrincipal(stack.formatArn({
        service: 'iam', region: '', resource: 'role',
        resourceName: VALUES_SYNC_CONTRACT.deployRoleName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      })),
      description: 'dev EKS metadata reader for generated Helm values',
      maxSessionDuration: Duration.hours(1),
    });
    this.role.addToPolicy(new PolicyStatement({
      actions: ['eks:DescribeCluster'], resources: [props.cluster.attrArn],
    }));
    new CfnAccessEntry(this, 'Access', {
      clusterName: props.cluster.ref, principalArn: this.role.roleArn, type: 'STANDARD',
      kubernetesGroups: [VALUES_SYNC_CONTRACT.kubernetesGroup],
    });

    // ADR-0034의 기존 relay·고정 목적지 문서와 호출자 세션 경계를 재사용한다.
    this.role.addToPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [arn('ec2', 'instance', props.relay.instance.instanceId)],
      conditions: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
    }));
    this.role.addToPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [arn('ssm', 'document', props.relay.sessionDocument.ref)],
    }));
    this.role.addToPolicy(new PolicyStatement({
      actions: ['ssmmessages:OpenDataChannel'], resources: [arn('ssm', 'session', '${aws:userid}-*')],
    }));
    this.role.addToPolicy(new PolicyStatement({
      actions: ['ssm:ResumeSession', 'ssm:TerminateSession'], resources: [arn('ssm', 'session', '*')],
      conditions: { StringEquals: {
        'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
        'ssm:resourceTag/aws:ssmmessages:target-id': props.relay.instance.instanceId,
      } },
    }));
  }
}
