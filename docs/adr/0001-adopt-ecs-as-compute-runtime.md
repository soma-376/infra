# 0001. 컴퓨트 런타임으로 ECS 채택

## Status

Accepted

## Context

MVP 백엔드는 OTel Collector, Post Processor, API Server, Batch Processor, ClickHouse까지 총 다섯 개의 컴포넌트를 컨테이너로 정의해둔 상태다. 이 컨테이너들을 실제 AWS 환경에 배포하려면 배포 자동화가 필요했고, 후보로 Elastic Beanstalk도 함께 검토했다.

## Decision

컴퓨트 런타임으로 ECS를 사용한다. 컨테이너 이미지는 ECR 프라이빗 레포지토리로 관리한다.

## Alternatives Considered

- **Elastic Beanstalk**: 추상화 수준이 높아 세밀한 컨테이너 배치 제어가 어려워 기각.
- **EC2 직접 운영**: 배포 자동화를 직접 구축해야 하는 부담이 커서 기각.
- **EKS**: MVP 규모 대비 운영 복잡도가 과잉이라 기각.

## Consequences/Tradeoffs

### Positive

- 태스크 정의(Task Definition)와 서비스 단위의 선언적 관리가 가능해진다.
- AWS CDK와의 통합이 자연스러워 인프라 코드로 배포 파이프라인을 일관되게 표현할 수 있다.
- ECS Cluster 자체는 과금 단위가 아닌 논리 그룹이므로, 이후 Fargate 서비스와 EC2 캐퍼시티를 하나의 클러스터에서 함께 운영하는 구조([ADR-0003](0003-hybrid-launch-type-ec2-clickhouse-fargate-apps.md))로 자연스럽게 이어진다.

### Negative

- 이 결정에 대해 원문에 기록된 부정적 결과는 없다. 트레이드오프는 위 Alternatives Considered의 기각 사유로 갈음한다.
