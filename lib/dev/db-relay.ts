import {
  BlockDeviceVolume, EbsDeviceVolumeType, Instance,
  InstanceType, ISecurityGroup, IVpc, MachineImage,
} from 'aws-cdk-lib/aws-ec2';
import { AccountPrincipal, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnDocument } from 'aws-cdk-lib/aws-ssm';
import { ArnFormat, Stack } from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import {
  DEV_DB_OPERATOR_ROLE_NAME, DEV_DB_RELAY_CLICKHOUSE_SESSION_DOCUMENT_NAME,
  DEV_DB_RELAY_AMI_ID, DEV_DB_RELAY_INSTANCE_TYPE, DEV_DB_RELAY_POSTGRES_SESSION_DOCUMENT_NAME,
} from './config';

interface DevDbRelayProps {
  readonly vpc: IVpc;
  readonly securityGroup: ISecurityGroup;
  readonly postgresEndpoint: string;
}

/** DB TCP 중계만 맡는다. Pod 조회와 DB 인증은 로컬 도구가 수행한다. (ADR-0038) */
export class DevDbRelay extends Construct {
  public readonly instance: Instance;
  public readonly operatorRole: Role;
  public readonly postgresSessionDocument: CfnDocument;
  public readonly clickHouseSessionDocument: CfnDocument;

  constructor(scope: Construct, id: string, props: DevDbRelayProps) {
    super(scope, id);
    const stack = Stack.of(this);
    const role = new Role(this, 'Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      description: 'dev database relay SSM instance role',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')],
    });
    this.instance = new Instance(this, 'Instance', {
      vpc: props.vpc, vpcSubnets: { subnets: [props.vpc.publicSubnets[0]] },
      instanceType: new InstanceType(DEV_DB_RELAY_INSTANCE_TYPE),
      machineImage: MachineImage.genericLinux({ [stack.region]: DEV_DB_RELAY_AMI_ID }),
      securityGroup: props.securityGroup, role,
      associatePublicIpAddress: true, requireImdsv2: true,
      blockDevices: [{ deviceName: '/dev/xvda', volume: BlockDeviceVolume.ebs(8, {
        encrypted: true, volumeType: EbsDeviceVolumeType.GP3, deleteOnTermination: true,
      }) }],
    });
    this.instance.addUserData('set -euo pipefail', 'systemctl enable --now amazon-ssm-agent');

    const localPort = (defaultPort: string) => ({
      type: 'String', default: defaultPort, description: 'Local TCP port for the database tunnel',
      allowedPattern: '^([1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$',
    });
    this.postgresSessionDocument = new CfnDocument(this, 'PostgresSessionDocument', {
      name: DEV_DB_RELAY_POSTGRES_SESSION_DOCUMENT_NAME,
      documentType: 'Session', documentFormat: 'JSON', updateMethod: 'NewVersion',
      content: {
        schemaVersion: '1.0', sessionType: 'Port',
        description: 'Port forwarding to the dev PostgreSQL database',
        parameters: { localPortNumber: localPort('15432') },
        properties: {
          type: 'LocalPortForwarding', host: props.postgresEndpoint,
          portNumber: '5432', localPortNumber: '{{ localPortNumber }}',
        },
      },
    });
    this.clickHouseSessionDocument = new CfnDocument(this, 'ClickHouseSessionDocument', {
      name: DEV_DB_RELAY_CLICKHOUSE_SESSION_DOCUMENT_NAME,
      documentType: 'Session', documentFormat: 'JSON', updateMethod: 'NewVersion',
      content: {
        schemaVersion: '1.0', sessionType: 'Port',
        description: 'Port forwarding to the dev ClickHouse Pod',
        parameters: {
          host: {
            type: 'String', description: 'Ready ClickHouse Pod IPv4 in the dev VPC',
            // DNS·loopback·IMDS를 받지 않는다. 실제 목적지는 Network의 CH SG:8123으로 제한한다.
            allowedPattern: '^10\\.1\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$',
          },
          localPortNumber: localPort('18123'),
        },
        properties: {
          type: 'LocalPortForwarding', host: '{{ host }}',
          portNumber: '8123', localPortNumber: '{{ localPortNumber }}',
        },
      },
    });

    this.operatorRole = new Role(this, 'OperatorRole', {
      roleName: DEV_DB_OPERATOR_ROLE_NAME,
      assumedBy: new AccountPrincipal(stack.account),
      description: 'dev database operator role for restricted SSM tunnels',
    });
    const arn = (service: string, resource: string, resourceName: string) => stack.formatArn({
      service, resource, resourceName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [arn('ec2', 'instance', this.instance.instanceId)],
      conditions: { BoolIfExists: { 'ssm:SessionDocumentAccessCheck': 'true' } },
    }));
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['ssm:StartSession'], resources: [this.postgresSessionDocument, this.clickHouseSessionDocument]
        .map(document => arn('ssm', 'document', document.ref)),
    }));
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['ssmmessages:OpenDataChannel'], resources: [arn('ssm', 'session', '${aws:userid}-*')],
    }));
    this.operatorRole.addToPolicy(new PolicyStatement({
      actions: ['ssm:ResumeSession', 'ssm:TerminateSession'], resources: [arn('ssm', 'session', '*')],
      conditions: { StringEquals: {
        'ssm:resourceTag/aws:ssmmessages:session-id': '${aws:userid}',
        'ssm:resourceTag/aws:ssmmessages:target-id': this.instance.instanceId,
      } },
    }));
  }
}
