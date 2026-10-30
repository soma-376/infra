import {
  AmazonLinuxCpuType, BlockDeviceVolume, EbsDeviceVolumeType, Instance, InstanceType, ISecurityGroup, ISubnet, IVpc, MachineImage,
} from 'aws-cdk-lib/aws-ec2';
import { IRole, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnDocument } from 'aws-cdk-lib/aws-ssm';
import { ArnFormat, Fn, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { PERF_EKS_RELAY_INSTANCE_TYPE, PERF_EKS_RELAY_SESSION_DOCUMENT_NAME } from './config';

interface PerfEksRelayProps {
  readonly vpc: IVpc;
  readonly subnet: ISubnet;
  readonly securityGroup: ISecurityGroup;
  readonly clusterEndpoint: string;
  readonly operatorRole: IRole;
}

/**
 * private EKS API의 TCP 중계(dev ADR-0034와 같은 방식). Kubernetes 인증은 로컬 operator 역할이 한다.
 * dev와 달리 private subnet에 두고 NAT로 SSM에 닿는다. public IP가 없다.
 */
export class PerfEksRelay extends Construct {
  public readonly instance: Instance;
  public readonly sessionDocument: CfnDocument;

  constructor(scope: Construct, id: string, props: PerfEksRelayProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const role = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'perf EKS API relay SSM instance role',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    this.instance = new Instance(this, 'Instance', {
      vpc: props.vpc, vpcSubnets: { subnets: [props.subnet] },
      instanceType: new InstanceType(PERF_EKS_RELAY_INSTANCE_TYPE),
      machineImage: MachineImage.latestAmazonLinux2023({ cpuType: AmazonLinuxCpuType.ARM_64 }),
      securityGroup: props.securityGroup, role,
      associatePublicIpAddress: false, requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: BlockDeviceVolume.ebs(8, {
        encrypted: true, volumeType: EbsDeviceVolumeType.GP3, deleteOnTermination: true,
      }) }],
    });
    this.instance.addUserData('set -euo pipefail', 'systemctl enable --now amazon-ssm-agent');

    this.sessionDocument = new CfnDocument(this, 'SessionDocument', {
      name: PERF_EKS_RELAY_SESSION_DOCUMENT_NAME,
      documentType: 'Session', documentFormat: 'JSON', updateMethod: 'NewVersion',
      content: {
        schemaVersion: '1.0', sessionType: 'Port',
        description: 'Port forwarding to the perf EKS private API',
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
