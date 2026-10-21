# dev OSS AWS Load Balancer Controller

ADR-0028의 TGB 전용 구성이다. 공식 chart 3.6.0과 controller v3.6.0을 함께 고정했다.
`vendor/`에는 공식 chart 원본, `crds/`에는 그 archive 안의 두 CRD 원본을 변경 없이 둔다.
`SOURCE.json`은 출처·controller commit·SHA256을 기록한다. upstream archive checksum은
[공식 Helm index](https://aws.github.io/eks-charts/index.yaml)의 digest와 대조했다.
`schemas/targetgroupbinding_elbv2.k8s.aws_v1beta1.json`은 고정 `crds.yaml`의
`spec.versions[name=v1beta1].schema.openAPIV3Schema`를 그대로 추출한 kubeconform 입력이다.

```bash
(cd helm/dev/platform/lbc && shasum -a 256 -c SHA256SUMS)
kubectl apply --server-side -f helm/dev/platform/lbc/crds/
helm upgrade --install aws-load-balancer-controller \
  helm/dev/platform/lbc/vendor/aws-load-balancer-controller-3.6.0.tgz \
  --namespace kube-system --skip-crds \
  --values helm/dev/platform/lbc/values.yaml --values generated/lbc.yaml \
  --wait --timeout 10m
```

CRD는 Helm upgrade가 자동 갱신하지 않으므로 고정 파일을 먼저 적용한다. 다음 갱신 때도
chart·controller·두 CRD·checksum과 IAM 호출을 함께 확인한다. Gateway CRD가 있어도 이
구성은 Gateway controller를 켜지 않는다. CRD 삭제는 해당 custom resource도 삭제하므로
일반 Helm rollback 절차에 CRD 삭제를 넣지 않는다.

`generated/lbc.yaml`은 배포된 CDK output의 `clusterName`·`region`·`vpcId`만 전달한다.
ServiceAccount는 `kube-system/aws-load-balancer-controller`이고 Pod Identity를 사용한다.
ServiceAccount의 IRSA role annotation은 필요하지 않다. controller는 앱 NodePool에 배치하며
ClickHouse 전용 taint를 tolerate하지 않는다. replica 1과 CPU/메모리는 dev 초기값이다.

LBC는 `elbv2.k8s.aws/v1beta1` TGB를 처리한다. v3.6.0 OSS TGB에는 `controllerClass`
필드가 없으며 Auto Mode의 `eks.amazonaws.com/v1` TGB와 섞지 않는다. Service/Gateway
controller·service mutator를 끄고 IngressClass를 만들지 않는다. Ingress controller 자체를
끄는 flag는 없으므로 전용 미사용 ingress class와 IAM 제한을 함께 사용한다.

CDK가 TG를 `soma-376-dev-eks-` 접두사로 만들고 `pulsemetry:eks-cluster=<clusterName>`
태그를 붙여야 LBC가 등록·해제를 할 수 있다. ECS TG를 전달하지 않는다. 역할에는
`RegisterTargets`·`DeregisterTargets`와 TGB 처리에 필요한 네 읽기 API만 둔다. node instance
ID는 Kubernetes Node의 providerID에서 읽으며 EC2 instance 변경 권한은 필요하지 않다.

`enableBackendSecurityGroup=false`·`enableManageBackendSecurityGroupRules=false`는 실제
v3.6.0 flag지만 직접 TGB의 SG 처리까지 비활성화하지는 않는다. TGB에서 `spec.networking`을
생략하고 Network가 SG 규칙을 소유한다. LBC는 networking이 없어도 SG GC를 조회하므로
`DescribeSecurityGroups`가 필요하다. CDK SG 규칙에는 LBC가 관리·정리하는
`elbv2.k8s.aws/targetGroupBinding=shared` description을 붙이지 않는다. IAM에는 SG 쓰기와
ALB/TG/listener의 생성·수정·삭제 권한이 없으며 CloudFormation 합성 검사로 이 경계를 고정한다.

로컬 lint/render·checksum·IAM 검사는 live Pod Identity·webhook reachability·target health의
증거가 아니다. 배포 뒤 실제 association·controller 로그·TG health를 별도 확인한다.

- [고정 v3.6.0 설정](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.6.0/docs/deploy/configurations.md)
- [고정 TGB networking 소스](https://github.com/kubernetes-sigs/aws-load-balancer-controller/blob/v3.6.0/pkg/networking/networking_manager.go)
- [TGB 안내](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/targetgroupbinding/targetgroupbinding/)
- [Pod Identity trust](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html)
- [ELBv2 IAM 권한표](https://docs.aws.amazon.com/service-authorization/latest/reference/list_elbv2.html)
