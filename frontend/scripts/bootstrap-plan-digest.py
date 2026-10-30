#!/usr/bin/env python3
"""plan 생성 시각만 제외한 전체 계획의 해시. state/비밀 원문은 출력하지 않는다."""
import hashlib
import json
import sys


def digest(plan):
    normalized = dict(plan)
    normalized.pop('timestamp', None)
    return hashlib.sha256(json.dumps(normalized, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


if __name__ == '__main__':
    print(digest(json.load(sys.stdin)))
