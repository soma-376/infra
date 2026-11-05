#!/usr/bin/env python3
"""검토된 infra helper로 원본 ZIP과 실행하지 않는 이미지 패키지를 검사한다."""
import hashlib
import io
import json
from pathlib import Path
import sys
import zipfile
from verify_image_contracts import verify_candidate

LIMIT = 4 * 1024 * 1024


def archive(raw):
    if len(raw) > LIMIT:
        raise ValueError("archive size")
    with zipfile.ZipFile(io.BytesIO(raw)) as bundle:
        entries = bundle.infolist()
        if len(entries) != 2 or {entry.filename for entry in entries} != {"completion.json", "completion.sha256"}:
            raise ValueError("archive files")
        for entry in entries:
            if entry.is_dir() or (entry.external_attr >> 16) & 0o170000 == 0o120000 or entry.file_size > LIMIT or entry.flag_bits & 1:
                raise ValueError("archive entry")
        completion = bundle.read("completion.json")
        if bundle.read("completion.sha256") != (hashlib.sha256(completion).hexdigest() + "\n").encode("ascii"):
            raise ValueError("archive digest")
        return completion


def main():
    if len(sys.argv) != 4:
        raise ValueError("arguments")
    operation, source, output = sys.argv[1:]
    raw = Path(source).read_bytes()
    if operation == "archive":
        Path(output).write_bytes(archive(raw))
    elif operation == "images":
        verify_candidate(json.loads(raw))
    else:
        raise ValueError("operation")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("원본 archive 또는 이미지 패키지 검증 실패", file=sys.stderr)
        sys.exit(1)
