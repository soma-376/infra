#!/usr/bin/env python3
"""실제 ECS 설정·Helm 출력과 backend OIDC DTO를 로컬 JVM에서 검증한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
# 기존 configtree fixture와 동일한 backend runtime 의존성만 사용한다.
CONFIGTREE = runpy.run_path(str(ROOT / "scripts/test-configtree.py"))
BOOT, KOTLIN = CONFIGTREE["BOOT"], CONFIGTREE["KOTLIN"]
SYNTHETIC = {
    "cognito-a": "fixture-A-only ' \" \\ : {} $ + = / 한글",
    "Cognito_B": "fixture-B-only-with-hyphen_and_underscore",
}

# TypeScript의 실제 ECS 설정 함수와 EKS 생성기를 사용한다. Secret 값은 이 입력에 없다.
GENERATE = r"""
const fs = require('node:fs');
const path = require('node:path');
const { dump } = require('js-yaml');
const { parseDashboardRuntimeConfig, userAuthEnvironment } = require('./lib/dev/dashboard-runtime-config.ts');
(async () => {
  const { generateValues } = await import('./scripts/eks-values.mjs');
  const input = JSON.parse(fs.readFileSync('test/fixtures/dashboard-runtime.json', 'utf8'));
  const scenario = process.argv[2];
  const local = scenario === 'true';
  const callbackBaseUrl = local ? 'http://localhost:8080' : 'https://auth.example.invalid';
  const failureRedirectUri = local ? 'http://localhost:3000/auth/callback' : 'https://dashboard.example.invalid/auth/callback';
  input.userAuth.allowedRedirectUris = [failureRedirectUri];
  input.oidc = {
    enabled: true,
    callbackBaseUrl,
    failureRedirectUri,
    callbackRegistrationId: 'fixture-oidc',
    clients: [
      { key: 'cognito-a', versionId: '33333333-3333-4333-8333-333333333333' },
      { key: 'Cognito_B', versionId: '44444444-4444-4444-8444-444444444444' },
    ],
  };
  if (scenario !== 'omitted') input.oidc.allowInsecureLocalhost = local;
  const ecs = userAuthEnvironment(parseDashboardRuntimeConfig(input), true);
  delete input.writerImage;
  const secret = name => `arn:aws:secretsmanager:ap-northeast-2:111111111111:secret:${name}-abc123`;
  const tg = name => `arn:aws:elasticloadbalancing:ap-northeast-2:111111111111:targetgroup/soma-376-dev-eks-${name}/0123456789abcdef`;
  const outputs = {
    DevDataStack: { OidcClientSecretArns: JSON.stringify(Object.fromEntries(input.oidc.clients.map(c => [c.key, secret('soma-376/dev/oidc/clients/' + c.key)]))) },
    DevEksStack: {
      EksDashboardApiNodePort: '30081',
      DashboardRdsSourceSecretArn: secret('dashboard-rds-source'), DashboardRdsCacheSecretArn: secret('dashboard-rds-cache'),
      DashboardClickHouseSourceSecretArn: secret('dashboard-ch-source'), DashboardClickHouseCacheSecretArn: secret('dashboard-ch-cache'),
      UserJwtPrivateKeySecretArn: secret('jwt-private'), UserJwtPublicKeysSecretArn: secret('jwt-public'),
      EksClusterName: 'soma-376-dev-eks', EksRegion: 'ap-northeast-2', EksVpcId: 'vpc-0123456789abcdef0',
      EksSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
      EksAppNodeSecurityGroupId: 'sg-0123456789abcdef0', EksClickhouseNodeSecurityGroupId: 'sg-0123456789abcdef1',
      EksClickhouseAvailabilityZone: 'ap-northeast-2a', EksNodeRoleName: 'soma-376-dev-eks-node',
      DbEndpoint: 'database.example.invalid', DbSecretArn: secret('db'), TokenHashSecretArn: secret('hmac'),
      AdminApiTokenSecretArn: secret('admin'), RawSignalBucketName: 'fixture-raw-signals',
      ApplicationLogGroupName: '/eks/dev/application', ArchivePrefix: 'eks_validation',
    },
    DevEdgeStack: {
      ValidationPublicBaseUrl: 'http://validation-alb.example.invalid',
      ValidationEnrollmentApiTargetGroupArn: tg('enroll-v'), ValidationTelemetryIngestTargetGroupArn: tg('ingest-v'),
      ValidationClickhouseTargetGroupArn: tg('ch-v'), ValidationDashboardApiTargetGroupArn: tg('dashboard-v'),
    },
  };
  const image = name => `111111111111.dkr.ecr.ap-northeast-2.amazonaws.com/soma-376/${name}@sha256:${'a'.repeat(64)}`;
  const values = generateValues(outputs, image('enrollment-api'), image('telemetry-ingest'), image('dashboard-api'), input);
  for (const [name, value] of Object.entries(values)) fs.writeFileSync(path.join(process.argv[1], name), dump(value));
  process.stdout.write(JSON.stringify({ ecs, values, oidc: input.oidc }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
"""


def run(argv, **kwargs):
    result = subprocess.run(argv, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "검증 명령 실패: " + argv[0])
    return result.stdout.strip()


def load_yaml_documents(node, source):
    return json.loads(run([node, "-e", "const fs=require('node:fs'); const yaml=require('js-yaml'); process.stdout.write(JSON.stringify(yaml.loadAll(fs.readFileSync(0,'utf8')).filter(Boolean)));"], cwd=ROOT, input=source))


def compile_backend_dtos(args, temp):
    backend = args.backend.resolve()
    versions = (backend / "gradle/libs.versions.toml").read_text()
    for key, version in (("springBoot", BOOT), ("kotlin", KOTLIN), ("jdk", "25")):
        if not re.search(r'^' + key + r'\s*=\s*"' + re.escape(version) + r'"', versions, re.M):
            raise RuntimeError(key + " 버전이 fixture 고정값과 다르므로 재검토가 필요하다")
    jars = []
    for group, artifact, version in CONFIGTREE["ARTIFACTS"]:
        matches = list((args.gradle_cache / group / artifact / version).glob("*/" + artifact + "-" + version + ".jar"))
        if len(matches) != 1:
            raise RuntimeError(f"Gradle cache 의존성이 필요하다: {group}:{artifact}:{version}")
        jars.append(str(matches[0]))
    dependency_classpath = os.pathsep.join(jars)
    source_dir = backend / "apps/enrollment-api/src/main/kotlin/com/team376/pulsemetry/enrollment/auth"
    sources = []
    for filename, class_name, prefix in (("OidcLoginConfig.kt", "OidcProperties", "pulsemetry.oidc"), ("UserAuthConfig.kt", "UserAuthProperties", "pulsemetry.user-auth")):
        source = source_dir / filename
        body = re.search(r'@ConfigurationProperties\("' + re.escape(prefix) + r'"\)\s*class ' + class_name + r'\s*\{.*?\n\}', source.read_text(), re.S)
        if not body:
            raise RuntimeError(class_name + " DTO 소스 범위가 바뀌었으므로 fixture 재검토가 필요하다")
        target = temp / (class_name + ".kt")
        # 소스의 DTO 선언을 그대로 컴파일하고 서버 Bean·네트워크 의존성만 제외한다.
        target.write_text("package com.team376.pulsemetry.enrollment.auth\nimport org.springframework.boot.context.properties.ConfigurationProperties\n" + body.group(0))
        sources.append(str(target))
        print(str(source.relative_to(backend)) + " sha256=" + hashlib.sha256(source.read_bytes()).hexdigest())
    classes = temp / "classes"
    classes.mkdir()
    run(["java", "-cp", dependency_classpath, "org.jetbrains.kotlin.cli.jvm.K2JVMCompiler", "-no-stdlib", "-no-reflect", "-jvm-target", "25", "-java-parameters", "-classpath", dependency_classpath, "-d", str(classes), *sources])
    classpath = str(classes) + os.pathsep + dependency_classpath
    run(["javac", "-cp", classpath, "-d", str(classes), str(ROOT / "test/scripts/configtree/OidcConfigFixture.java")])
    return classpath


def validate_case(args, classpath, scenario):
    with tempfile.TemporaryDirectory(prefix="pulsemetry-oidc-config-" + scenario + "-") as directory:
        temp = Path(directory)
        generated = temp / "generated"
        generated.mkdir()
        emitted = json.loads(run([args.node, "--import", "tsx", "-e", GENERATE, str(generated), scenario], cwd=ROOT))
        local = scenario == "true"
        callback = "http://localhost:8080" if local else "https://auth.example.invalid"
        failure_redirect = "http://localhost:3000/auth/callback" if local else "https://dashboard.example.invalid/auth/callback"

        def render(release, chart, files):
            return load_yaml_documents(args.node, run([args.helm, "template", release, chart, "--namespace", "pulsemetry-dev", "--kube-version", "1.36.0", *[part for file in files for part in ("-f", str(file))]], cwd=ROOT))

        deployment = next(doc for doc in render("enrollment-api", "helm/dev/workloads/spring-app", [ROOT / "helm/dev/workloads/enrollment-api.yaml", generated / "enrollment-api.yaml"]) if doc["kind"] == "Deployment")
        runtime = next(doc for doc in render("pulsemetry-runtime", "helm/dev/runtime/chart", [generated / "runtime.yaml"]) if doc["metadata"]["name"] == "enrollment-api-runtime")
        pod = deployment["spec"]["template"]["spec"]
        eks_environment = {entry["name"]: entry["value"] for entry in pod["containers"][0]["env"]}
        aliases = {key: "PULSEMETRY_OIDC_CLIENT_SECRET_" + str(index) for index, key in enumerate(sorted(SYNTHETIC))}
        expected_map = {"[" + key + "]": "${" + alias + "}" for key, alias in aliases.items()}
        for kind, environment in (("ECS", emitted["ecs"]), ("EKS", eks_environment)):
            spring = json.loads(environment["SPRING_APPLICATION_JSON"])["pulsemetry"]
            if spring["oidc"]["client-secrets"] != expected_map:
                raise RuntimeError(kind + "의 실제 출력에 OIDC map key/alias가 일치하지 않는다")
            if spring["oidc"].get("allow-insecure-localhost") is not local:
                raise RuntimeError(kind + "/" + scenario + "의 localhost 예외 boolean이 일치하지 않는다")
            if any(value in json.dumps(environment) for value in SYNTHETIC.values()):
                raise RuntimeError(kind + " 설정에 synthetic Secret 원문이 포함됐다")

        objects = load_yaml_documents(args.node, runtime["spec"]["parameters"]["objects"])[0]
        clients = {entry["key"]: entry for entry in emitted["values"]["runtime.yaml"]["oidc"]["clients"]}
        for key, alias in aliases.items():
            item = next((item for item in objects if item.get("objectAlias") == alias), None)
            if not item or item.get("objectVersion") != clients[key]["versionId"] or item.get("objectName") != clients[key]["secretArn"] or "jmesPath" in item:
                raise RuntimeError("실제 SPC의 OIDC 원본·고정 버전·전체 문자열 alias가 일치하지 않는다")

        mount, keys = temp / "configtree", temp / "keys"
        mount.mkdir(mode=0o700)
        keys.mkdir(mode=0o700)
        required = emitted["values"]["enrollment-api.yaml"]["runtime"]["requiredFiles"]
        if not set(aliases.values()).issubset(required):
            raise RuntimeError("OIDC alias가 실제 필수 파일 목록에서 빠졌다")
        for name in required:
            (mount / name).write_text("fixture-only-unused-by-oidc")
            (mount / name).chmod(0o444)
        for key, alias in aliases.items():
            (mount / alias).chmod(0o600)
            (mount / alias).write_text(SYNTHETIC[key])
            (mount / alias).chmod(0o444)
        for filename in ("private.pem", "release-2026-10.pem"):
            (keys / filename).write_text("fixture-only-no-key-parsing")
        command = pod["initContainers"][0]["args"][0].replace("/mnt/secrets-store", str(mount)).replace("/mnt/user-jwt/keys", str(keys))
        run(["/bin/sh", "-ec", command])
        modes = ("missing", "empty", "unreadable") if os.geteuid() != 0 else ("missing", "empty")
        for alias in aliases.values():
            target = mount / alias
            saved = target.read_bytes()
            for mode in modes:
                target.chmod(0o600)
                if mode == "missing":
                    target.unlink()
                elif mode == "empty":
                    target.write_bytes(b"")
                else:
                    target.chmod(0)
                result = subprocess.run(["/bin/sh", "-ec", command], capture_output=True)
                if result.returncode == 0:
                    raise RuntimeError("실제 Helm init command가 OIDC " + mode + " 파일을 거부하지 않았다")
                if target.exists():
                    target.chmod(0o600)
                target.write_bytes(saved)
                target.chmod(0o444)
        print("EKS/" + scenario + ": 실제 Helm init command OIDC " + "/".join(modes) + " 거부 PASS")
        if os.geteuid() == 0:
            print("EKS: root 실행이므로 unreadable 파일 검증 생략")

        yaml = args.backend.resolve() / "apps/enrollment-api/src/main/resources/application.yaml"
        print(str(yaml.relative_to(args.backend.resolve())) + " sha256=" + hashlib.sha256(yaml.read_bytes()).hexdigest())
        base = {key: value for key, value in os.environ.items() if not key.startswith(("PULSEMETRY_", "SPRING_", "FIXTURE_"))}
        base.update({
            "FIXTURE_EXPECT_COGNITO_A": SYNTHETIC["cognito-a"],
            "FIXTURE_EXPECT_COGNITO_B": SYNTHETIC["Cognito_B"],
            "FIXTURE_EXPECT_ALLOW_INSECURE_LOCALHOST": str(local).lower(),
            "FIXTURE_EXPECT_CALLBACK": callback,
            "FIXTURE_EXPECT_FAILURE_REDIRECT": failure_redirect,
        })
        for kind, actual in (("ECS", emitted["ecs"]), ("EKS", eks_environment)):
            environment = {**base, **actual}
            if kind == "ECS":
                environment.update({alias: SYNTHETIC[key] for key, alias in aliases.items()})
            else:
                environment["SPRING_CONFIG_IMPORT"] = "configtree:" + str(mount) + "/"
            print(run(["java", "-cp", classpath, "OidcConfigFixture", str(yaml), kind + "/" + scenario], env=environment))


def validate(args):
    with tempfile.TemporaryDirectory(prefix="pulsemetry-oidc-dtos-") as directory:
        classpath = compile_backend_dtos(args, Path(directory))
        for scenario in ("omitted", "false", "true"):
            validate_case(args, classpath, scenario)
    print("PASS: localhost 예외 생략/false/true의 실제 ECS 설정 함수·EKS 생성기/Helm 출력·Spring Boot " + BOOT + "·backend DTO 로컬 검증. 실제 Secret/CSI/UID 10001/Cognito 로그인은 검증하지 않았다.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", type=Path, default=ROOT.parent / "pulsemetry-backend")
    parser.add_argument("--gradle-cache", type=Path, default=Path(os.environ.get("GRADLE_USER_HOME", str(Path.home() / ".gradle"))) / "caches/modules-2/files-2.1")
    parser.add_argument("--node", default=shutil.which("node") or "node")
    parser.add_argument("--helm", default=os.environ.get("HELM_BIN", shutil.which("helm") or "helm"))
    validate(parser.parse_args())


if __name__ == "__main__":
    main()
