#!/usr/bin/env python3
"""생성 시각·참조 목록 순서를 정규화한 계획 해시. state/비밀은 출력하지 않는다."""
import hashlib
import json
import sys


def digest(plan):
    normalized = dict(plan)
    normalized.pop('timestamp', None)
    # Terraform 1.13.5는 의미상 집합인 이 목록을 매번 같은 순서로 내보내지 않는다.
    # 내부 attribute 경로와 리소스 값의 배열 순서는 의미가 있으므로 그대로 보존한다.
    if 'relevant_attributes' in normalized:
        normalized['relevant_attributes'] = sorted(
            normalized['relevant_attributes'],
            key=lambda item: json.dumps(item, sort_keys=True, separators=(',', ':')),
        )
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


if __name__ == '__main__':
    print(digest(json.load(sys.stdin)))
