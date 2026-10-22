#!/usr/bin/env python3
"""공식 ARM64 Fluent Bit으로 앱 로그 envelope를 만들어 CloudWatch metric filter 입력 샘플로 저장한다.

실제 values의 tail·CRI multiline·grep·record_modifier·rewrite_tag 설정을 그대로 쓴다. Kubernetes API가 없으므로
kubernetes filter만 같은 metadata 구조를 붙이는 Lua로 대신한다. CloudWatch로 보내지 않고 file output을 쓴다.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "cr.fluentbit.io/fluent/fluent-bit:5.1.3"
CONTAINER_ID = "0" * 63 + "1"
NAMESPACE = "pulsemetry-dev"
SPRING = "2026-10-22T01:00:00.000Z  {level} 1 --- [{app}] [{thread}] {logger} : {message}"

# expected는 이 줄과 일치해야 하는 metric filter event다. None은 어떤 실패 filter와도 일치하면 안 된다.
SAMPLES = [
    ("gateway-rejected", "telemetry-gateway", "telemetry_gateway_rejected", "stdout", SPRING.format(
        level="INFO", app="pulsemetry-telemetry-gateway", thread="nio-8082-exec-1", logger="c.t.p.t.g.api.GatewayOtlpController",
        message="event=telemetry_gateway_rejected stage=authenticate reason=invalid_token status=401")),
    ("publish-failed", "telemetry-gateway", "telemetry_publish_failed", "stdout", SPRING.format(
        level="WARN", app="pulsemetry-telemetry-gateway", thread="nio-8082-exec-2", logger="c.t.p.t.g.api.GatewayOtlpController",
        message="event=telemetry_publish_failed signal=logs reason=timeout cause=TimeoutException")),
    ("permanent-failure", "telemetry-ingest", "telemetry_permanent_failure", "stdout", SPRING.format(
        level="WARN", app="pulsemetry-telemetry-ingest", thread="ntainer#0-0-C-1", logger="c.t.p.t.c.TelemetryRecordListener",
        message="event=telemetry_permanent_failure messageId=m-1 topic=pulsemetry-dev-telemetry-ingress-main partition=0 offset=7 stage=decode reason=invalid_payload cause=-")),
    ("retry-exhausted", "telemetry-ingest", "telemetry_retry_exhausted", "stdout", SPRING.format(
        level="ERROR", app="pulsemetry-telemetry-ingest", thread="ntainer#0-0-C-1", logger="c.t.p.t.c.TelemetryFailureReporter",
        message="event=telemetry_retry_exhausted messageId=m-2 topic=pulsemetry-dev-telemetry-ingress-main partition=1 offset=42 stage=insert reason=unavailable attempt=4 kid=-")),
    ("commit-failed", "telemetry-ingest", "telemetry_commit_failed", "stdout", SPRING.format(
        level="ERROR", app="pulsemetry-telemetry-ingest", thread="ntainer#0-0-C-1", logger="c.t.p.t.c.TelemetryFailureReporter",
        message="event=telemetry_commit_failed topic=pulsemetry-dev-telemetry-ingress-main partition=2 offset=9 stage=commit reason=commit_failed cause=CommitFailedException")),
    # CRI가 한 줄을 P/F 두 조각으로 나눠도 결합 후 filter와 일치해야 한다.
    ("gateway-rejected-split", "telemetry-gateway", "telemetry_gateway_rejected", "split", SPRING.format(
        level="INFO", app="pulsemetry-telemetry-gateway", thread="nio-8082-exec-3", logger="c.t.p.t.g.api.GatewayOtlpController",
        message="event=telemetry_gateway_rejected stage=validate reason=unsupported_media_type status=415")),
    ("transient-failure", "telemetry-ingest", None, "stdout", SPRING.format(
        level="WARN", app="pulsemetry-telemetry-ingest", thread="ntainer#0-0-C-1", logger="c.t.p.t.c.TelemetryRecordListener",
        message="event=telemetry_transient_failure messageId=m-3 topic=pulsemetry-dev-telemetry-ingress-main partition=1 offset=43 stage=insert reason=unavailable attempt=1")),
    ("startup", "telemetry-ingest", None, "stdout", SPRING.format(
        level="INFO", app="pulsemetry-telemetry-ingest", thread="main", logger="c.t.p.t.TelemetryIngestApplicationKt",
        message="Started TelemetryIngestApplicationKt in 9.6 seconds")),
    ("gc-stderr", "telemetry-ingest", None, "stderr",
        "[2026-10-22T01:00:01.000+0000][info][gc] GC(3) Pause Young (Normal) (G1 Evacuation Pause) 24M->6M(64M) 3.120ms"),
    ("clickhouse-json", "clickhouse", None, "stderr", json.dumps({
        "date_time_utc": "2026-10-22T01:00:02Z", "thread_name": "TCPHandler", "level": "Error",
        "logger_name": "executeQuery", "message": "Code: 241. DB::Exception: Memory limit (total) exceeded: \"retry_exhausted\" is not an event"},
        separators=(",", ":"))),
]

LUA = """
-- kubernetes filter(Labels On, Annotations Off)가 붙이는 metadata 구조만 재현한다.
function add_kubernetes(tag, timestamp, record)
  local pod, namespace, container, id = string.match(tag, "([^.]+)_([^_]+)_(.+)%-(%x+)%.log$")
  if pod == nil then return -1, timestamp, record end
  record["kubernetes"] = {
    pod_name = pod, namespace_name = namespace, pod_id = "00000000-0000-4000-8000-000000000001",
    labels = { ["app.kubernetes.io/name"] = container, ["app.kubernetes.io/instance"] = container },
    host = "i-0123456789abcdef0", container_name = container, docker_id = id,
    container_hash = "fixture@sha256:" .. string.rep("0", 64), container_image = "fixture/" .. container .. ":local",
  }
  return 2, timestamp, record
end
"""


def command(args, input=None, check=True, timeout=120):
    result = subprocess.run(args, cwd=ROOT, input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"명령 실패: {args[:3]}\n{result.stderr[-3000:]}")
    return result


def runtime_config():
    script = """import{readFileSync}from'node:fs';import{load}from'js-yaml';
const v=load(readFileSync('helm/dev/runtime/fluent-bit-values.yaml','utf8'));
process.stdout.write(JSON.stringify({inputs:v.config.inputs,filters:v.config.filters,env:v.env}));"""
    return json.loads(command(["node", "--input-type=module", "-e", script]).stdout)


def section(config, name, plugin):
    blocks = re.split(r"(?m)^(?=\s*\[" + name + r"\])", config)
    found = [block for block in blocks if re.search(r"(?m)^\s*Name\s+" + re.escape(plugin) + r"\s*$", block)]
    assert len(found) == 1, f"{name} {plugin} 블록이 정확히 하나여야 한다"
    return found[0]


def cri_lines(stream, line):
    if stream == "split":
        middle = len(line) // 2
        return [f"2026-10-22T01:00:00.000000001Z stdout P {line[:middle]}", f"2026-10-22T01:00:00.000000002Z stdout F {line[middle:]}"]
    return [f"2026-10-22T01:00:00.000000001Z {stream} F {line}"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "helm/observability/tests/fluent-bit")
    args = parser.parse_args()
    metadata = command(["docker", "image", "inspect", IMAGE], check=False)
    if metadata.returncode:
        command(["docker", "pull", "--platform", "linux/arm64", IMAGE], timeout=300)
        metadata = command(["docker", "image", "inspect", IMAGE])
    image = json.loads(metadata.stdout)[0]
    assert image["Architecture"] == "arm64", "ARM64 이미지만 검증한다"
    actual = runtime_config()
    tail = section(actual["inputs"], "INPUT", "tail")
    # 경로와 상태 위치만 컨테이너 안 임시 경로로 바꾸고 나머지 tail 옵션은 그대로 쓴다.
    tail = re.sub(r"(?m)^(\s*Path)\s+.*$", r"\1 /smoke/containers/*.log", tail)
    tail = re.sub(r"(?m)^(\s*DB)\s+.*$", r"\1 /state/tail.db", tail)
    tail = tail.replace("Tag kube.*", "Tag kube.*").rstrip() + "\n    Exit_On_Eof Off\n"
    filters = re.split(r"(?m)^(?=\s*\[FILTER\])", actual["filters"])
    kubernetes = section(actual["filters"], "FILTER", "kubernetes")
    rest = "".join(block for block in filters if block.strip() and block != kubernetes)
    for option in ["Labels On", "Annotations Off", "Merge_Log Off", "Keep_Log On"]:
        assert option in kubernetes, f"kubernetes filter에 {option}이 필요하다"
    config = f"""[SERVICE]
    Flush 1
    Log_Level info
    Parsers_File /fluent-bit/etc/parsers.conf
    storage.path /state/buffer
{tail}[FILTER]
    Name lua
    Match kube.*
    script /smoke/kubernetes.lua
    call add_kubernetes
{rest}[OUTPUT]
    Name file
    Match application.*
    Path /out
    File application.jsonl
    Format plain
[OUTPUT]
    Name file
    Match observability.*
    Path /out
    File observability.jsonl
    Format plain
"""
    env = [item for entry in actual["env"] for item in ["--env", f"{entry['name']}={entry['value']}"]]
    with tempfile.TemporaryDirectory(prefix="proj191-envelope-", dir="/private/tmp") as temporary:
        temp = Path(temporary)
        (temp / "smoke/containers").mkdir(parents=True)
        (temp / "out").mkdir()
        (temp / "state").mkdir()
        (temp / "smoke/kubernetes.lua").write_text(LUA)
        (temp / "smoke/fluent-bit.conf").write_text(config)
        for name, container, _, stream, line in SAMPLES:
            path = temp / f"smoke/containers/{name}_{NAMESPACE}_{container}-{CONTAINER_ID}.log"
            path.write_text("\n".join(cri_lines(stream, line)) + "\n")
        # 관측 namespace 로그는 다른 출력으로 가야 한다.
        (temp / f"smoke/containers/grafana-0_pulsemetry-observability_grafana-{CONTAINER_ID}.log").write_text(
            "2026-10-22T01:00:00.000000001Z stdout F logger=server t=2026-10-22T01:00:00Z level=info msg=\"HTTP Server Listen\"\n")
        os.chmod(temp / "out", 0o777)
        name = "proj191-envelope-" + hashlib.sha256(temporary.encode()).hexdigest()[:12]
        command(["docker", "run", "--detach", "--name", name, "--network", "none", *env,
                 "--mount", f"type=bind,source={temp / 'smoke'},target=/smoke,readonly",
                 "--mount", f"type=bind,source={temp / 'out'},target=/out",
                 "--mount", f"type=bind,source={temp / 'state'},target=/state",
                 image["Id"], "--config", "/smoke/fluent-bit.conf"])
        try:
            expected_records = len(SAMPLES) + 1
            for _ in range(30):
                time.sleep(1)
                lines = [line for file in ["application.jsonl", "observability.jsonl"] if (temp / "out" / file).exists()
                         for line in (temp / "out" / file).read_text().splitlines() if line]
                if len(lines) >= expected_records:
                    break
            else:
                raise RuntimeError("Fluent Bit 출력이 기대 개수에 도달하지 않았다: " + command(["docker", "logs", name], check=False).stderr[-2000:])
        finally:
            command(["docker", "rm", "--force", "--volumes", name], check=False)
        application = [json.loads(line) for line in (temp / "out/application.jsonl").read_text().splitlines() if line]
        observability = [json.loads(line) for line in (temp / "out/observability.jsonl").read_text().splitlines() if line]
    assert len(application) == len(SAMPLES) and len(observability) == 1, "namespace별 출력 분리가 다르다"
    by_pod = {record["kubernetes"]["pod_name"]: record for record in application}
    samples = []
    for name, container, expected, stream, line in SAMPLES:
        record = by_pod[name]
        assert record["log"] == line, f"{name}: CRI 결합 후 원문이 달라졌다"
        assert record["stream"] == ("stdout" if stream == "split" else stream)
        samples.append({"name": name, "expectedEvent": expected, "message": json.dumps(record, ensure_ascii=False, separators=(",", ":"))})
    overhead = [len(sample["message"].encode()) - len(json.loads(sample["message"])["log"].encode()) for sample in samples]
    keys = sorted({key for record in application for key in record})
    kubernetes_keys = sorted({key for record in application for key in record["kubernetes"]})
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "metric-filter-samples.jsonl").write_text("".join(json.dumps(sample, ensure_ascii=False) + "\n" for sample in samples))
    evidence = {
        "image": IMAGE, "imageDigests": image.get("RepoDigests", []), "architecture": "arm64",
        "runtimeConfigSource": "helm/dev/runtime/fluent-bit-values.yaml",
        "configSha256": hashlib.sha256(config.encode()).hexdigest(),
        "real": ["tail(CRI multiline, DB, Read_From_Head)", "grep namespace allowlist", "record_modifier environment·cluster", "rewrite_tag application/observability", "plain JSON 직렬화"],
        "emulated": "kubernetes filter metadata(Lua) — Kubernetes API 조회 없음",
        "notRun": "cloudwatch_logs output·CloudWatch filter engine(TestMetricFilter)",
        "topLevelFields": keys, "kubernetesFields": kubernetes_keys,
        "applicationRecords": len(application), "observabilityRecords": len(observability),
        # 원문 한 줄당 envelope가 더하는 bytes다. 실제 Pod label 수에 따라 커지므로 비용 산정은 dev 실측을 쓴다.
        "envelopeOverheadBytes": {"min": min(overhead), "max": max(overhead)},
        "cri": "P/F 분할 줄은 결합되지만 _p는 첫 조각 값(P)을 유지한다. time은 CRI 원래 시각 문자열이다",
    }
    (args.output_dir / "envelope-evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(f"PASS: Fluent Bit envelope {len(samples)}건, 필드 {keys}, kubernetes {kubernetes_keys}")


if __name__ == "__main__":
    main()
