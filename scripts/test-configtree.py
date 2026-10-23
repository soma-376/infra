#!/usr/bin/env python3
"""현재 backend YAML/DTO의 configtree 계약을 실제 JVM에서 무해하게 검증한다."""
import argparse
import base64
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BOOT = "4.1.0"
KOTLIN = "2.3.21"
PRICING_SOURCE = "libs/telemetry-adapter/src/main/kotlin/com/team376/pulsemetry/telemetry/adapter/observation/pricing/CodeburnReferencePrices.kt"
# backend BOM과 compiler의 고정 runtime 의존성만 사용한다.
ARTIFACTS = [
    ("org.springframework.boot", "spring-boot", BOOT),
    *[("org.springframework", "spring-" + name, "7.0.8") for name in ("core", "beans", "context", "aop", "expression")],
    ("commons-logging", "commons-logging", "1.3.5"),
    ("org.jspecify", "jspecify", "1.0.0"),
    ("org.yaml", "snakeyaml", "2.6"),
    ("io.micrometer", "micrometer-observation", "1.17.0"),
    ("io.micrometer", "micrometer-commons", "1.17.0"),
    *[("org.jetbrains.kotlin", name, KOTLIN) for name in ("kotlin-stdlib", "kotlin-reflect", "kotlin-script-runtime", "kotlin-compiler-embeddable", "kotlin-daemon-embeddable")],
    ("org.jetbrains.kotlinx", "kotlinx-coroutines-core-jvm", "1.8.0"),
    ("org.jetbrains", "annotations", "13.0"),
]
FILES = {
    "PULSEMETRY_DB_USERNAME": "fixture-user",
    "PULSEMETRY_DB_PASSWORD": "fixture password ' \\\\ : {} !",
    "PULSEMETRY_TOKEN_HASH_SECRET": "fixture-hmac-only-not-a-real-secret",
    "PULSEMETRY_ADMIN_API_TOKEN": "fixture-admin-only-not-a-real-secret",
}


def run(argv, **kwargs):
    result = subprocess.run(argv, text=True, capture_output=True, **kwargs)
    if result.returncode:
        # 컴파일 진단만 출력한다. synthetic 값을 포함하는 JVM assertion은 이름만 출력한다.
        raise RuntimeError(result.stderr.strip() or "명령 검증 실패: " + argv[0])
    return result.stdout.strip()


def validate(args, backend):
    backend = backend.resolve()
    versions = (backend / "gradle/libs.versions.toml").read_text()
    for key, version in (("springBoot", BOOT), ("kotlin", KOTLIN), ("jdk", "25")):
        if not re.search(r'^' + key + r'\s*=\s*"' + re.escape(version) + r'"', versions, re.M):
            raise RuntimeError(key + " 버전이 fixture 고정값과 다르므로 재검토가 필요하다")
    jar_paths = []
    for group, artifact, version in ARTIFACTS:
        matches = list((args.gradle_cache / group / artifact / version).glob("*/" + artifact + "-" + version + ".jar"))
        if len(matches) != 1:
            raise RuntimeError(f"Gradle cache 의존성이 필요하다: {group}:{artifact}:{version}. backend 의존성을 먼저 준비하거나 --gradle-cache를 지정한다")
        jar_paths.append(str(matches[0]))
    dependency_classpath = os.pathsep.join(jar_paths)
    source_paths = [
        backend / "apps/enrollment-api/src/main/kotlin/com/team376/pulsemetry/enrollment/config/PulsemetryProperties.kt",
        backend / "apps/telemetry-ingest/src/main/kotlin/com/team376/pulsemetry/telemetry/config/TelemetryIngestProperties.kt",
    ]
    pricing_source = backend / PRICING_SOURCE
    pricing_version = re.search(r'^\s*public const val VERSION:\s*String\s*=\s*"([A-Za-z0-9._-]+)"\s*$', pricing_source.read_text(), re.M)
    if not pricing_version:
        raise RuntimeError("CodeburnReferencePrices.VERSION이 단순 문자열 상수인지 재검토가 필요하다")
    yaml_paths = [backend / ("apps/" + app + "/src/main/resources/application.yaml") for app in ("enrollment-api", "telemetry-ingest")]
    # 이 source snapshot 자체를 수정하지 않고 hash로 재현 대상을 기록한다.
    for source in [*source_paths, pricing_source, *yaml_paths]:
        print(str(source.relative_to(backend)) + " sha256=" + hashlib.sha256(source.read_bytes()).hexdigest())

    with tempfile.TemporaryDirectory(prefix="pulsemetry-configtree-") as temp_dir:
        temp = Path(temp_dir)
        classes = temp / "classes"
        classes.mkdir()
        # DTO의 네트워크 기본 상수와 참조 가격 버전만 격리한다. DB/HTTP/AWS·가격 계산 구현은 로딩하지 않는다.
        # 가격 버전은 실제 backend 소스에서 읽는다. configtree 바인딩에 불필요한 가격표·카탈로그 의존은 추가하지 않는다.
        defaults = {
            "ClickHouseHttpClient.java": 'package com.team376.pulsemetry.persistence.telemetry; import java.time.Duration; public class ClickHouseHttpClient { public static final String DEFAULT_DATABASE = "default"; public static final Duration DEFAULT_TIMEOUT = Duration.ofSeconds(30); }',
            "OtlpIngestHandler.java": 'package com.team376.pulsemetry.telemetry.collector; public class OtlpIngestHandler { public static final long DEFAULT_MAX_DECOMPRESSED_BYTES = 104857600L; }',
            "CodeburnReferencePrices.java": 'package com.team376.pulsemetry.telemetry.adapter.observation.pricing; public class CodeburnReferencePrices { public static final String VERSION = "' + pricing_version.group(1) + '"; }',
        }
        for name, source in defaults.items():
            (temp / name).write_text(source)
        run(["javac", "-d", str(classes), *[str(temp / name) for name in defaults]])
        classpath = str(classes) + os.pathsep + dependency_classpath
        run(["java", "-cp", dependency_classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "25", "-java-parameters", "-classpath", classpath, "-d", str(classes), *map(str, source_paths)])
        run(["javac", "-cp", classpath, "-d", str(classes), str(ROOT / "test/scripts/configtree/ConfigtreeFixture.java")])

        template = (ROOT / "helm/dev/workloads/spring-app/templates/deployment.yaml").read_text()
        match = re.search(r'for file in \{\{ join " " \.Values\.runtime\.requiredFiles \}\}; do\n(?P<body>.*?)\n\s*done', template, re.S)
        if not match:
            raise RuntimeError("앱 chart의 필수 파일 검사 command를 확인할 수 없다")
        for app, yaml_path in zip(("enrollment-api", "telemetry-ingest"), yaml_paths):
            names = list(FILES) if app == "enrollment-api" else list(FILES)[:3]
            mount = temp / app
            mount.mkdir(mode=0o700)
            for name in names:
                (mount / name).write_text(FILES[name])
                (mount / name).chmod(0o444)
            for name in ("_source_db_json", "_source_admin_json") if app == "enrollment-api" else ("_source_db_json",):
                (mount / name).write_text('{"fixture": "source-json-is-not-a-property-consumer"}')
                (mount / name).chmod(0o400)
            command = "for file in " + " ".join(names) + "; do\n" + match.group("body").replace("/mnt/secrets-store", str(mount)) + "\ndone"
            run(["/bin/sh", "-ec", command])
            # chart의 실제 command를 각 필수 파일 누락·빈 파일에서 실행한다.
            for name in names:
                path = mount / name
                saved = path.read_bytes()
                path.unlink()
                missing = subprocess.run(["/bin/sh", "-ec", command], capture_output=True)
                if missing.returncode == 0:
                    raise RuntimeError(name + " 누락을 chart init command가 거절하지 않았다")
                path.write_bytes(b"")
                empty = subprocess.run(["/bin/sh", "-ec", command], capture_output=True)
                if empty.returncode == 0:
                    raise RuntimeError(name + " 빈 파일을 chart init command가 거절하지 않았다")
                path.write_bytes(saved)
                path.chmod(0o444)
            print(app + ": chart init 필수 파일 누락·빈 파일 거절 PASS")
            environment = {key: value for key, value in os.environ.items() if not key.startswith(("PULSEMETRY_", "SPRING_", "FIXTURE_"))}
            environment.update({
                "SPRING_CONFIG_IMPORT": "configtree:" + str(mount) + "/",
                "FIXTURE_EXPECT_USERNAME": FILES["PULSEMETRY_DB_USERNAME"],
                "FIXTURE_EXPECT_PASSWORD": FILES["PULSEMETRY_DB_PASSWORD"],
                "FIXTURE_EXPECT_HASH": FILES["PULSEMETRY_TOKEN_HASH_SECRET"],
                "FIXTURE_EXPECT_ADMIN": FILES["PULSEMETRY_ADMIN_API_TOKEN"],
                "PULSEMETRY_ARCHIVE_TYPE": "s3",
                "PULSEMETRY_ARCHIVE_BUCKET": "fixture-archive",
                "PULSEMETRY_ARCHIVE_PREFIX": "eks_validation",
            })
            argv = ["java", "-cp", classpath, "ConfigtreeFixture", app, str(yaml_path)]
            print(run([*argv, "configtree"], env=environment))
            for name, expected in (("PULSEMETRY_DB_USERNAME", "USERNAME"), ("PULSEMETRY_DB_PASSWORD", "PASSWORD"), ("PULSEMETRY_TOKEN_HASH_SECRET", "HASH")):
                environment[name] = "fixture-environment-override-" + expected.lower()
                environment["FIXTURE_EXPECT_" + expected] = environment[name]
            if app == "enrollment-api":
                environment["PULSEMETRY_ADMIN_API_TOKEN"] = "fixture-environment-admin-override"
                environment["FIXTURE_EXPECT_ADMIN"] = environment["PULSEMETRY_ADMIN_API_TOKEN"]
            print(run([*argv, "OS 환경변수 우선순위"], env=environment))
            environment["SPRING_CONFIG_IMPORT"] = "configtree:" + str(temp / "absent") + "/"
            print(run([*argv, "missing-directory"], env=environment))
    print("PASS: 실제 Spring Boot 4.1.0·backend YAML·Kotlin DTO 로컬 검증. CSI/Pod Identity/UID 10001 mount는 배포 검증 대기.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--backend", type=Path, default=ROOT.parent / "pulsemetry-backend")
    source.add_argument("--fetch-ref", help="GitHub에서 읽을 immutable backend commit SHA (소스 파일 6개만 임시 저장)")
    parser.add_argument("--gradle-cache", type=Path, default=Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1")
    args = parser.parse_args()
    if not args.fetch_ref:
        validate(args, args.backend)
        return
    if not re.fullmatch(r"[a-f0-9]{40}", args.fetch_ref):
        raise RuntimeError("--fetch-ref는 40자리 immutable commit SHA여야 한다")
    paths = [
        "gradle/libs.versions.toml",
        "apps/enrollment-api/src/main/resources/application.yaml",
        "apps/telemetry-ingest/src/main/resources/application.yaml",
        "apps/enrollment-api/src/main/kotlin/com/team376/pulsemetry/enrollment/config/PulsemetryProperties.kt",
        "apps/telemetry-ingest/src/main/kotlin/com/team376/pulsemetry/telemetry/config/TelemetryIngestProperties.kt",
        PRICING_SOURCE,
    ]
    with tempfile.TemporaryDirectory(prefix="pulsemetry-backend-source-") as source_dir:
        backend = Path(source_dir)
        for path in paths:
            content = run(["gh", "api", "repos/soma-376/pulsemetry-backend/contents/" + path + "?ref=" + args.fetch_ref, "--jq", ".content"])
            target = backend / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(base64.b64decode(content))
        print("backend 고정 commit: " + args.fetch_ref)
        validate(args, backend)


if __name__ == "__main__":
    main()
