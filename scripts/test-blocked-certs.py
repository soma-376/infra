#!/usr/bin/env python3
"""로컬 ARM64 Temurin 이미지에서 임시 mount와 JVM의 차단 목록 로드를 검증한다.

이미지 pull·앱 시작·네트워크 접속 없이 실행한다. --image에는 로컬에 있는 이미지 ID/digest를 권장한다.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parent.parent
FILES = ROOT / "helm/dev/workloads/spring-app/files"


def run(args):
    return subprocess.run(args, check=True, text=True, capture_output=True).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="이미 로컬에 있는 ARM64 backend/Temurin JRE 25 이미지")
    args = parser.parse_args()
    source = json.loads((FILES / "SOURCE.json").read_text())
    blocked = FILES / "blocked.certs"
    digest = hashlib.sha256(blocked.read_bytes()).hexdigest()
    if digest != source["sha256"]:
        raise RuntimeError("공식 원본 SHA-256 불일치")

    image = run(["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}} {{.Id}}", args.image]).strip()
    platform, image_id = image.split()
    if platform != "linux/arm64":
        raise RuntimeError(f"ARM64 Linux 이미지가 필요함: {platform}")

    with tempfile.TemporaryDirectory(prefix="proj253-jvm-") as directory:
        temp = Path(directory)
        # Docker의 UID 10001이 임시 fixture 디렉터리를 읽도록 한다. 공개 자료만 담는다.
        temp.chmod(0o755)
        classes = temp / "classes"
        classes.mkdir(mode=0o755)
        run([os.environ.get("JAVAC_BIN", "javac"), "--release", "25", "-d", str(classes),
             str(ROOT / "test/scripts/configtree/BlockedCertsFixture.java")])
        base = ["docker", "run", "--rm", "--pull=never", "--network", "none", "--read-only",
                "--user", "10001:10001", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--entrypoint", "java",
                "--mount", f"type=bind,src={classes},dst=/verification/classes,readonly",
                "--mount", f"type=bind,src={blocked},dst=/verification/expected-blocked.certs,readonly"]
        java_args = [image_id, "-XX:-UsePerfData", "--add-opens=java.base/sun.security.util=ALL-UNNAMED",
                     "-cp", "/verification/classes", "BlockedCertsFixture"]
        results = {}
        for mode in ["baseline", "mounted"]:
            command = base.copy()
            if mode == "mounted":
                command += ["--mount", f"type=bind,src={blocked},dst=/opt/java/openjdk/lib/security/blocked.certs,readonly"]
            output = run(command + java_args + [mode])
            results[mode] = dict(line.split("=", 1) for line in output.splitlines())
        for key in ["security_files_sha256", "default_trust_issuers", "java_version"]:
            if results["baseline"][key] != results["mounted"][key]:
                raise RuntimeError(f"기존 JVM/security 구성 변경: {key}")
        if results["mounted"]["blocked_sha256"] != digest or results["mounted"]["jvm_loaded_verified"] != "true":
            raise RuntimeError("마운트/JVM 로드 결과 불일치")
        print(json.dumps({"image": image_id, "platform": platform, "uid": 10001,
                          "network": "none", "results": results}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f"검증 명령 실패 ({error.returncode}):\n{error.stdout}\n{error.stderr}") from error
