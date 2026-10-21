# dev EKS 기반 Helm

CDK `DevEksStack` 배포 뒤 outputs를 values에 전달한다. 이 chart는 AWS 리소스를 만들지 않는다.

| 값 | CDK output |
|---|---|
| `nodeRoleName` | `EksNodeRoleName` |
| `subnetIds` | `EksSubnetIds`의 쉼표 구분 목록 |
| `appNodeSecurityGroupId` | `EksAppNodeSecurityGroupId` |
| `clickhouseNodeSecurityGroupId` | `EksClickhouseNodeSecurityGroupId` |
| `clickhouseAvailabilityZone` | `EksClickhouseAvailabilityZone` |

NodePool은 ARM64 On-Demand t4g.medium만 허용한다. ClickHouse의 AZ·taint는 StatefulSet과 맞춰야 한다.
Auto Mode가 제공하는 DNS·VPC 네트워킹·Pod Identity agent·EBS CSI를 중복 설치하지 않는다.
클러스터에는 기본 NodePool이 없으므로 이 chart를 LBC·워크로드보다 먼저 설치한다. replica를 가진 앱이
배치될 때 필요한 노드가 생성되며, chart 설치 자체가 고정 노드 수를 보장하지 않는다.

앱 CPU 한도 8과 ClickHouse CPU 한도 4는 각각 t4g.medium 최대 4대/2대의 초기 예산이다.
ClickHouse Pod는 1개지만 노드 교체 중 새 노드를 만들 여유를 둔다. 용량·비용·가용성은 실환경에서 검증한다.
StorageClass/PV는 Retain이며 namespace와 StorageClass도 Helm 삭제 시 보존한다. Helm uninstall/rollback은
데이터 백업·복구 절차가 아니다. `WhenEmpty`도 drift·노드 만료 교체를 막지는 않는다.

[NodePool 공식 지원 필드](https://docs.aws.amazon.com/eks/latest/userguide/create-node-pool.html),
[NodeClass 공식 필드](https://docs.aws.amazon.com/eks/latest/userguide/create-node-class.html),
[Auto Mode DNS](https://docs.aws.amazon.com/eks/latest/userguide/auto-networking.html)를 기준으로 구성했다.
Auto Mode에서 지원하지 않는 `kubernetes.io/os` NodePool requirement를 추가하지 않는다.
