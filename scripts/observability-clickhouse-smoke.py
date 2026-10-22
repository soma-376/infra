#!/usr/bin/env python3
"""실제 Helm 설정으로 ARM64 ClickHouse의 metrics·console 로그·data 유지 경계를 검사한다.

Docker 컨테이너/volume은 임의 이름의 전용 리소스만 만들고 finally에서 정리한다.
AWS·기존 Docker 리소스를 변경하지 않는다. Python 표준 라이브러리, Node/js-yaml, Helm이 필요하다.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "helm/dev/workloads/clickhouse"
LABEL = "pulsemetry.observability-smoke"


def run(args, *, input=None, check=True, timeout=120):
    result = subprocess.run(args, input=input, text=True, capture_output=True, cwd=ROOT, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"명령 실패: {args[0]} {args[1]}\n{result.stderr[-4000:]}")
    return result


def docker(*args, **kwargs):
    return run(["docker", *args], **kwargs)


def inspect(name):
    return json.loads(docker("inspect", name).stdout)[0]


def port(name, number):
    return int(inspect(name)["NetworkSettings"]["Ports"][f"{number}/tcp"][0]["HostPort"])


def request(number, path="/", query=None, query_id=None, expected=200):
    suffix = urllib.parse.urlencode({"query_id": query_id}) if query_id else ""
    url = f"http://127.0.0.1:{number}{path}" + ("?" + suffix if suffix else "")
    data = query.encode() if query is not None else None
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data), timeout=10) as response:
            status, body = response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        status, body = error.code, error.read().decode()
    if status != expected:
        raise RuntimeError(f"HTTP 상태 {status}, 기대 {expected}: {body[:500]}")
    return body


def wait_ready(name):
    number = port(name, 8123)
    for _ in range(90):
        try:
            if request(number, "/ping").strip() == "Ok.":
                return number
        except (OSError, RuntimeError):
            pass
        if not inspect(name)["State"]["Running"]:
            logs = docker("logs", "--tail", "15", name)
            raise RuntimeError(f"ClickHouse 시작 실패\n{logs.stdout[-1500:]}\n{logs.stderr[-1500:]}")
        time.sleep(1)
    raise RuntimeError("ClickHouse readiness 90초 초과")


def normalized_logs(stdout, stderr):
    result = []
    for stream, text in [("stdout", stdout), ("stderr", stderr)]:
        for line in text.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # entrypoint 안내·동적 linker 경고는 ClickHouse server JSON이 아니다.
            if not isinstance(event, dict) or "message" not in event:
                continue
            message = str(event["message"])
            message = re.sub(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", "<uuid>", message)
            message = re.sub(r"\b[0-9a-f]{12,64}\b", "<id>", message)
            message = re.sub(r"(?<!version )\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b", "<address>", message)
            stack_trace = "Stack trace" in message
            message = message.split("Stack trace", 1)[0].rstrip()
            result.append({"stream": stream, "level": event.get("level"),
                           "logger_name": event.get("logger_name"), "message": message[:2000], "stackTracePresent": stack_trace})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--helm", default=os.environ.get("HELM_BIN", "helm"))
    parser.add_argument("--output-dir", type=Path, default=ROOT / "helm/observability/tests/clickhouse")
    parser.add_argument("--expected-image-digest", help="기록한 RepoDigest와 동일한 이미지로 재실행할 때 사용한다")
    args = parser.parse_args()
    if not shutil.which("docker"):
        raise RuntimeError("Docker가 필요하다")
    rendered = run([args.helm, "template", "clickhouse", str(CHART), "-n", "pulsemetry-dev",
                    "--kube-version", "1.36.0", "--set", "observability.enabled=true",
                    "--set", "availabilityZone=ap-northeast-2a"]).stdout
    extract = """import{loadAll}from'js-yaml';let s='';for await(const c of process.stdin)s+=c;
const d=loadAll(s), cm=d.find(x=>x?.kind==='ConfigMap'&&x.metadata.name==='clickhouse-observability');
const c=d.find(x=>x?.kind==='StatefulSet').spec.template.spec.containers[0];
process.stdout.write(JSON.stringify({xml:cm.data['observability.xml'],image:c.image,env:c.env}));"""
    config = json.loads(run(["node", "--input-type=module", "-e", extract], input=rendered).stdout)
    image = config["image"]
    metadata_result = docker("image", "inspect", image, check=False)
    if metadata_result.returncode:
        docker("pull", "--platform", "linux/arm64", image, timeout=300)
        metadata_result = docker("image", "inspect", image)
    image_meta = json.loads(metadata_result.stdout)[0]
    if image_meta["Architecture"] != "arm64":
        raise RuntimeError("ARM64 이미지만 검증한다")
    if args.expected_image_digest and args.expected_image_digest not in image_meta.get("RepoDigests", []):
        raise RuntimeError("기대 image digest와 현재 tag가 다르다. 새 artifact를 별도로 검토해야 한다")
    run_id = "proj191-ch-" + uuid.uuid4().hex[:12]
    volume = run_id + "-data"
    containers = []
    created_volume = False
    with tempfile.TemporaryDirectory(prefix="proj191-ch-", dir="/private/tmp") as temporary:
        xml = Path(temporary) / "observability.xml"
        xml.write_text(config["xml"])
        xml.chmod(0o444)
        try:
            docker("volume", "create", "--label", f"{LABEL}={run_id}", volume)
            created_volume = True

            def start(suffix, observation):
                name = run_id + "-" + suffix
                command = ["run", "--detach", "--name", name, "--label", f"{LABEL}={run_id}",
                           "--platform", "linux/arm64", "--cpus", "1", "--memory", "2g",
                           "--publish", "127.0.0.1::8123", "--publish", "127.0.0.1::9363",
                           "--mount", f"type=volume,source={volume},target=/var/lib/clickhouse"]
                for entry in config["env"]:
                    command.extend(["--env", f"{entry['name']}={entry['value']}"])
                if observation:
                    command.extend(["--mount", f"type=bind,source={xml},target=/etc/clickhouse-server/config.d/observability.xml,readonly"])
                command.append(image_meta["Id"])
                containers.append(name)
                docker(*command)
                return name, wait_ready(name)

            baseline, http = start("baseline", False)
            version = request(http, query="SELECT version() FORMAT TSV").strip()
            baseline_database = request(http, query="SELECT currentDatabase() FORMAT TSV").strip()
            request(http, query="CREATE DATABASE observability_smoke")
            request(http, query="CREATE TABLE observability_smoke.events (id UInt64, value String) ENGINE=MergeTree ORDER BY id")
            request(http, query="INSERT INTO observability_smoke.events VALUES (1,'fixture'),(2,'fixture'),(3,'fixture')")
            definition = request(http, query="SHOW CREATE TABLE observability_smoke.events FORMAT TSV")
            baseline_path = docker("exec", baseline, "clickhouse", "extract-from-config", "--config-file",
                                   "/var/lib/clickhouse/preprocessed_configs/config.xml", "--key", "path").stdout.strip()
            docker("stop", "--time", "45", baseline)
            observed, http = start("observed", True)
            assert request(http, query="SELECT count() FROM observability_smoke.events FORMAT TSV").strip() == "3", "기존 rows 유지 실패"
            assert request(http, query="SHOW CREATE TABLE observability_smoke.events FORMAT TSV") == definition, "DDL 변경"
            assert request(http, query="SELECT currentDatabase() FORMAT TSV").strip() == baseline_database == "default"
            assert docker("exec", observed, "clickhouse", "extract-from-config", "--config-file",
                          "/var/lib/clickhouse/preprocessed_configs/config.xml", "--key", "path").stdout.strip() == baseline_path
            request(http, query="INSERT INTO observability_smoke.events VALUES (4,'fixture'),(5,'fixture')")
            request(http, query="SELECT unknown_observability_function(1)", query_id="proj191-smoke-select-error", expected=404)
            request(http, query="INSERT INTO observability_smoke.events VALUES ('invalid_uint','fixture')",
                    query_id="proj191-smoke-insert-error", expected=400)
            # async metrics refresh 이후 실제 exporter가 반환한 값만 기록한다.
            time.sleep(2)
            metrics = request(port(observed, 9363), "/metrics")
            native_query = docker("exec", observed, "clickhouse-client", "--query", "SELECT count() FROM observability_smoke.events").stdout.strip()
            assert native_query == "5", "native 9000 또는 기존 데이터 경계 오류"
            files = docker("exec", observed, "sh", "-c", "find /var/log/clickhouse-server -type f -name '*.log' -size +0c -print").stdout.strip()
            assert not files, "console 외 중복 log file이 생성됐다"
            docker("stop", "--time", "45", observed)
            state = inspect(observed)["State"]
            assert state["ExitCode"] == 0 and not state["OOMKilled"], "정상 종료 실패"
            capture = docker("logs", observed)
            logs = normalized_logs(capture.stdout, capture.stderr)
            startup = [event for event in logs if "Ready for connections" in event["message"]]
            errors = [event for event in logs if event["level"] == "Error" and "observability" in event["message"]]
            shutdown = [event for event in logs if "Shutting down" in event["message"] or "shut down" in event["message"].lower()]
            assert startup and errors and shutdown, "시작·오류·종료 JSON console 증거 누락"
            assert not re.search(r"^\d{4}[.-]\d{2}[.-]\d{2}.*<(?:Trace|Debug|Information|Warning|Error|Fatal)>",
                                 capture.stdout + capture.stderr, re.MULTILINE), "평문 server logger가 남았다"
            names = sorted(set(re.findall(r"^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{| )", metrics, re.MULTILINE)))
            dashboard = (ROOT / "helm/observability/pulsemetry-observability/dashboards/pulsemetry-clickhouse.json").read_text()
            rules = "\n".join(path.read_text() for path in (ROOT / "helm/observability/pulsemetry-observability/rules").glob("*"))
            expected = sorted(set(re.findall(r"ClickHouse(?:Metrics|AsyncMetrics|ProfileEvents)_[A-Za-z0-9_]+", dashboard + rules)))
            present = sorted(set(expected) & set(names))
            missing = sorted(set(expected) - set(names))
            required = ["ClickHouseProfileEvents_InsertedRows", "ClickHouseProfileEvents_FailedQuery",
                        "ClickHouseProfileEvents_FailedInsertQuery", "ClickHouseMetrics_MemoryTracking"]
            assert all(name in names for name in required), "활동을 유발한 핵심 metric 누락"
            selected = [line for line in metrics.splitlines() if any(
                line.startswith(name + " ") or line.startswith(name + "{") or
                line.startswith("# HELP " + name + " ") or line.startswith("# TYPE " + name + " ") for name in expected)]
            evidence = {
                "scope": "로컬 Docker linux/arm64, AWS 및 live EKS 검증 아님",
                "image": image, "imageDigests": image_meta.get("RepoDigests", []), "version": version,
                "architecture": image_meta["Architecture"], "cpuLimit": 1, "memoryLimit": "2GiB",
                "configSource": str(CHART.relative_to(ROOT) / "templates/observability.yaml"),
                "configSha256": hashlib.sha256(config["xml"].encode()).hexdigest(),
                "httpHealth": True, "native9000": True, "metrics9363": True,
                "database": baseline_database, "dataPathBeforeAndAfter": baseline_path,
                "existingRowsPreserved": 3, "rowsAfterInsert": 5, "tableDefinitionUnchanged": True,
                "serverLogFormat": "json", "startupJsonRecords": len(startup), "errorJsonRecords": len(errors),
                "shutdownJsonRecords": len(shutdown), "serverLogStreams": sorted(set(e["stream"] for e in logs)),
                "nonemptyDuplicateLogFiles": [], "exitCode": state["ExitCode"], "oomKilled": state["OOMKilled"],
                "exportedMetricNames": len(names), "dashboardMetricsPresent": present, "dashboardMetricsAbsent": missing,
                "absentMetricPolicy": "조건별 부재는 NoData다. 0으로 치환하지 않는다.",
            }
            args.output_dir.mkdir(parents=True, exist_ok=True)
            (args.output_dir / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
            (args.output_dir / "dashboard-metrics.prom").write_text("\n".join(selected) + "\n")
            error_samples = [next(event for event in errors if "unknown_observability_function" in event["message"]),
                             next(event for event in errors if "invalid_uint" in event["message"])]
            (args.output_dir / "server-log-samples.jsonl").write_text("\n".join(json.dumps(event, ensure_ascii=False) for event in (startup[:1] + error_samples + shutdown[-2:])) + "\n")
            (args.output_dir / "observability.xml").write_text(config["xml"])
            print(f"PASS: ClickHouse {version} ARM64 / metrics9363 / JSON 시작·오류·종료 / 기존3rows·DDL보존 / native9000; dashboard {len(present)} present, {len(missing)} NoData")
        finally:
            cleanup_failures = []
            for name in reversed(containers):
                data = docker("inspect", name, check=False)
                if data.returncode == 0 and json.loads(data.stdout)[0]["Config"]["Labels"].get(LABEL) == run_id:
                    if docker("rm", "--force", "--volumes", name, check=False).returncode:
                        cleanup_failures.append(name)
            if created_volume:
                if docker("volume", "rm", volume, check=False).returncode:
                    cleanup_failures.append(volume)
            if cleanup_failures:
                raise RuntimeError("테스트 전용 리소스 정리 실패: " + ", ".join(cleanup_failures))


if __name__ == "__main__":
    main()
