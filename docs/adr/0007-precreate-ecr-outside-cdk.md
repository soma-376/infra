# ADR-0007: ECR 레포지토리는 CDK 관리 밖에서 선(先)생성

- **Status**: Accepted
- **Date**: 2026-07-24

## Context

CDK 스택이 ECR 레포지토리를 함께 생성하도록 구성하면, 스택의 첫 배포 시점에는 아직 이미지가 push되지 않은 상태다. 이 상태에서 ECS 서비스가 이미지를 가져오지 못해 기동에 실패하고, 결과적으로 스택 전체가 롤백되는 닭-달걀 문제가 발생한다.

## Decision

ECR 레포지토리(`post-processor`, `api-server`, `batch-processor`)는 CLI 또는 콘솔로 먼저 생성하고 이미지를 push한 뒤, CDK에서는 `ecr.Repository.fromRepositoryName`으로 참조만 한다. OTel Collector와 ClickHouse는 공식 이미지를 그대로 사용하므로 이 대상에서 제외된다.

## Alternatives Considered

- **ECR 전용 스택을 분리해 먼저 배포**: 스택 수가 늘어나는 부담이 있어 기각.
- **cdk-ecr-deployment 등으로 이미지까지 CDK가 동시에 배포**: 구성 복잡도가 늘어나 기각.

## Consequences

- 인프라를 최초 배포하기 전에 반드시 이미지 push가 선행되어야 한다. 이 순서는 런북에 명시해야 한다.
- CDK 스택은 이미지 존재 여부와 무관하게 레포지토리 참조만 하므로, 스택 자체의 배포 안정성은 이미지 준비 상태에 영향을 받지 않는다.
