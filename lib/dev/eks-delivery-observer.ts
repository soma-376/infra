import { CfnAccessEntry, CfnCluster, CfnPodIdentityAssociation } from 'aws-cdk-lib/aws-eks';
import { ArnPrincipal, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { ArnFormat, Duration, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { DELIVERY_CONTRACT as D } from '../common/delivery-contract';
import { DevEksRelay } from './eks-relay';

/** API 읽기와 검증 Job의 identity. Secret 원문은 runner에게 허용하지 않는다. */
export class DevEksDeliveryObserver extends Construct {
  public readonly role: Role;
  public readonly verifierRole: Role;
  constructor(scope: Construct, id: string, props: { cluster: CfnCluster; relay: DevEksRelay; bucket: IBucket; archivePrefix: string; runtimeSecretArns: string[] }) {
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

    this.verifierRole = new Role(this, 'VerifierRole', {
      description: 'Dedicated dev deployment verifier metadata and probe input access',
      assumedBy: new ServicePrincipal('pods.eks.amazonaws.com').withSessionTags().withConditions({ StringEquals: {
        'aws:RequestTag/eks-cluster-name': props.cluster.ref,
        'aws:RequestTag/kubernetes-namespace': D.namespace,
        'aws:RequestTag/kubernetes-service-account': D.serviceAccount,
      } }),
    });
    new CfnPodIdentityAssociation(this, 'VerifierIdentity', { clusterName: props.cluster.ref,
      namespace: D.namespace, serviceAccount: D.serviceAccount, roleArn: this.verifierRole.roleArn, disableSessionTags: false });
    // 정확한 원본 이름의 Secrets Manager 자동 접미사만 허용한다. 운영자가 별도 준비한다.
    this.verifierRole.addToPolicy(new PolicyStatement({ actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [stack.formatArn({ service: 'secretsmanager', resource: 'secret', resourceName: `${D.probeSecretName}-??????`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })] }));
    this.verifierRole.addToPolicy(new PolicyStatement({ actions: ['secretsmanager:DescribeSecret'], resources: props.runtimeSecretArns }));
    this.verifierRole.addToPolicy(new PolicyStatement({ actions: ['s3:ListBucket'], resources: [props.bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': `${props.archivePrefix}/claude_code/logs/*` }, NumericLessThanEquals: { 's3:max-keys': '1' } } }));
  }
}
