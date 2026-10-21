import {
  AmazonLinuxCpuType, BlockDeviceVolume, EbsDeviceVolumeType, Instance,
  InstanceType, ISecurityGroup, IVpc, MachineImage,
} from 'aws-cdk-lib/aws-ec2';
import { IRole, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnDocument } from 'aws-cdk-lib/aws-ssm';
import { ArnFormat, Fn, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { DEV_EKS_RELAY_INSTANCE_TYPE, DEV_EKS_RELAY_SESSION_DOCUMENT_NAME } from './eks-config';

interface DevEksRelayProps {
  readonly vpc: IVpc;
  readonly securityGroup: ISecurityGroup;
  readonly clusterEndpoint: string;
  readonly operatorRole: IRole;
}

/** TCP 중계만 맡는다. Kubernetes 인증은 로컬 operator 역할로 수행한다. */
export class DevEksRelay extends Construct {
  public readonly instance: Instance;
  public readonly sessionDocument: CfnDocument;

  constructor(scope: Construct, id: string, props: DevEksRelayProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const role = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'dev EKS API relay SSM instance role',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    this.instance = new Instance(this, 'Instance', {
      vpc: props.vpc, vpcSubnets: { subnets: [props.vpc.publicSubnets[0]] },
      instanceType: new InstanceType(DEV_EKS_RELAY_INSTANCE_TYPE),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      securityGroup: props.securityGroup, role,
      associatePublicIpAddress: true, requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: BlockDeviceVolume.ebs(8, {
        encrypted: true, volumeType: EbsDeviceVolumeType.GP3, deleteOnTermination: true,
      }) }],
    });
    // AL2023 표준 AMI에 포함된 Agent를 사용한다. 실제 버전·Online 상태는 배포 후 확인한다.
    this.instance.addUserData('set -euo pipefail', 'systemctl enable --now amazon-ssm-agent');

    this.sessionDocument = new CfnDocument(this, 'SessionDocument', {
      name: DEV_EKS_RELAY_SESSION_DOCUMENT_NAME,
      documentType: 'Session', documentFormat: 'JSON', updateMethod: 'NewVersion',
      content: {
        schemaVersion: '1.0', sessionType: 'Port',
        description: 'Port forwarding to the dev EKS private API',
        parameters: {
          localPortNumber: {
            type: 'String', default: '8443', description: 'Local TCP port for the EKS API tunnel',
            allowedPattern: '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$',
          },
        },
        properties: {
          type: 'LocalPortForwarding',
          host: Fn.select(2, Fn.split('/', props.clusterEndpoint)),
          portNumber: '443', localPortNumber: '{{ localPortNumber }}',
        },
      },
    });

    const arn = (service: string, resource: string, resourceName: string) => stack.formatArn({
      service, resource, resourceName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [arn('ec2', 'instance', this.instance.instanceId)],
      // AWS 예시처럼 키가 없으면 통과하고, 있으면 true를 요구한다. 문서 ARN 허용은 별도로 제한한다.
      conditions: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
    }));
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [arn('ssm', 'document', this.sessionDocument.ref)],
    }));
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['ssmmessages:OpenDataChannel'], resources: [arn('ssm', 'session', '${aws:userid}-*')],
    }));
    props.operatorRole.addToPrincipalPolicy(new PolicyStatement({
      actions: ['ssm:ResumeSession', 'ssm:TerminateSession'], resources: [arn('ssm', 'session', '*')],
      conditions: { StringEquals: {
        'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
        'ssm:resourceTag/aws:ssmmessages:target-id': this.instance.instanceId,
      } },
    }));
  }
}
