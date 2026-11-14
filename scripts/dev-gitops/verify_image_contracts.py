#!/usr/bin/env python3
"""이미지를 실행하지 않고 immutable digest의 패키지 계약과 ARM64·label을 읽는다."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

MAX_CONTRACT = 256 * 1024
MAX_TAR = MAX_CONTRACT + 20 * 1024
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
INDEX_TYPES = {"application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"}
IMAGE_TYPES = {"application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"}


def command(arguments, env=None, input_bytes=None):
    result = subprocess.run(arguments, input=input_bytes, capture_output=True, env=env, timeout=180, check=False)
    if result.returncode:
        raise ValueError("이미지 읽기 전용 검사 실패")
    return result.stdout


def arm64_digest(manifest, root_digest):
    if not DIGEST.fullmatch(root_digest) or manifest.get("schemaVersion") != 2:
        raise ValueError("이미지 manifest 형식 오류")
    if manifest.get("mediaType") in IMAGE_TYPES:
        return root_digest
    if manifest.get("mediaType") not in INDEX_TYPES or not isinstance(manifest.get("manifests"), list):
        raise ValueError("이미지 index 형식 오류")
    choices = [item for item in manifest["manifests"] if item.get("platform", {}).get("os") == "linux"
               and item.get("platform", {}).get("architecture") == "arm64"
               and item.get("platform", {}).get("variant", "v8") == "v8"]
    if len(choices) != 1 or choices[0].get("mediaType") not in IMAGE_TYPES or not DIGEST.fullmatch(choices[0].get("digest", "")):
        raise ValueError("이미지 index의 고유 ARM64 manifest가 필요하다")
    return choices[0]["digest"]


def docker_environment(base, directory, run=command):
    """인증 파일을 복사하지 않고 현재 로컬 daemon과 검토된 buildx 위치만 보존한다."""
    endpoint = (base.get("DOCKER_HOST") if not base.get("DOCKER_CONTEXT") else None) or run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], base).decode().strip()
    if not re.fullmatch(r"unix:///[^\r\n\x00]+", endpoint):
        raise ValueError("이미지 검사는 로컬 Docker daemon만 사용한다")
    plugins = json.loads(run(["docker", "info", "--format", "{{json .ClientInfo.Plugins}}"], base))
    paths = [item.get("Path") for item in plugins if item.get("Name") == "buildx"]
    if len(paths) != 1 or not isinstance(paths[0], str) or not Path(paths[0]).is_absolute() or not Path(paths[0]).is_file():
        raise ValueError("고정 Docker Buildx 실행 파일이 필요하다")
    Path(directory, "config.json").write_text(json.dumps({"cliPluginsExtraDirs": [str(Path(paths[0]).parent)]}))
    env = {**base, "DOCKER_HOST": endpoint, "DOCKER_CONFIG": str(directory)}
    for key in ("DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"):
        env.pop(key, None)
    return env


def contract_from_tar(raw):
    if len(raw) > MAX_TAR:
        raise ValueError("이미지 계약 archive 크기 초과")
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        entries = archive.getmembers()
        if len(entries) != 1:
            raise ValueError("이미지 계약 archive 목록 오류")
        entry = entries[0]
        if entry.name != "deployment-contract.json" or not entry.isfile() or entry.issym() or entry.islnk() or not 0 < entry.size <= MAX_CONTRACT:
            raise ValueError("이미지 계약 archive 경로·형식 오류")
        content = archive.extractfile(entry).read(MAX_CONTRACT + 1)
        if len(content) != entry.size:
            raise ValueError("이미지 계약 archive 불완전")
        return content


def verify_packaged(reference, expected, env=None, run=command):
    if not 0 < len(expected) <= MAX_CONTRACT:
        raise ValueError("배포 계약 크기 오류")
    # create는 filesystem만 준비한다. start/run/exec는 호출하지 않는다.
    run(["docker", "pull", "--platform", "linux/arm64", reference], env)
    container = run(["docker", "create", "--platform", "linux/arm64", "--entrypoint", "/bin/true", reference], env).decode("ascii").strip()
    if not re.fullmatch(r"[a-f0-9]{64}", container):
        raise ValueError("검사 container 식별자 오류")
    try:
        # stdout는 임시 파일에 제한 시간 동안 받는다. 내용·실패 진단은 로그에 출력하지 않는다.
        with tempfile.TemporaryFile() as output:
            result = subprocess.run(["docker", "cp", container + ":/app/deployment-contract.json", "-"],
                                    env=env, stdout=output, stderr=subprocess.DEVNULL, timeout=60, check=False)
            if result.returncode or output.tell() > MAX_TAR:
                raise ValueError("이미지 패키지 계약 읽기 실패")
            output.seek(0)
            actual = contract_from_tar(output.read(MAX_TAR + 1))
        if actual != expected:
            raise ValueError("이미지 패키지 계약이 원본 B와 다르다")
    finally:
        run(["docker", "rm", "--volumes", container], env)


def verify_candidate(manifest, base_env=None):
    env = dict(os.environ if base_env is None else base_env)
    account = json.loads(command(["aws", "sts", "get-caller-identity", "--output", "json"], env))["Account"]
    if not re.fullmatch(r"[0-9]{12}", account) or env.get("AWS_REGION") != "ap-northeast-2":
        raise ValueError("이미지 조회 계정·리전 오류")
    registry = account + ".dkr.ecr.ap-northeast-2.amazonaws.com"
    with tempfile.TemporaryDirectory(prefix="gitops-docker-") as directory:
        env = docker_environment(env, directory)
        password = command(["aws", "ecr", "get-login-password", "--region", "ap-northeast-2"], env)
        command(["docker", "login", "--username", "AWS", "--password-stdin", registry], env, password)
        del password
        for app, image in manifest["images"].items():
            reference = registry + "/" + image["repository"] + "@" + image["digest"]
            source_manifest = json.loads(command(["docker", "buildx", "imagetools", "inspect", reference, "--raw"], env))
            if arm64_digest(source_manifest, image["digest"]) != image["arm64ManifestDigest"]:
                raise ValueError("원본 B의 ARM64 child manifest 불일치")
            contract = manifest["deploymentContracts"][app]
            verify_packaged(reference, contract["content"].encode("utf-8"), env)
            inspected = json.loads(command(["docker", "image", "inspect", reference], env))
            if not isinstance(inspected, list) or len(inspected) != 1:
                raise ValueError("이미지 config 목록 오류")
            config = inspected[0]
            labels = config.get("Config", {}).get("Labels", {}) or {}
            if config.get("Os") != "linux" or config.get("Architecture") != "arm64" or labels.get("io.pulsemetry.backend-commit") != manifest["backendCommit"] or labels.get("io.pulsemetry.deployment-contract-sha256") != contract["sha256"]:
                raise ValueError("이미지 ARM64·계약 label 불일치")
