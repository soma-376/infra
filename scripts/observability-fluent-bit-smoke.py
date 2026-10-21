#!/usr/bin/env python3
"""공식 ARM64 Fluent Bit으로 v1/v2 storage metrics와 실제 runtime config dry-run 범위를 확인한다."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = "cr.fluentbit.io/fluent/fluent-bit:5.1.3"


def command(args, input=None, check=True, timeout=90):
    result = subprocess.run(args, cwd=ROOT, input=input, text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"명령 실패: {args[:2]}\n{result.stderr[-3000:]}")
    return result


def docker(*args, **kwargs):
    return command(["docker", *args], **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "helm/observability/tests/fluent-bit")
    parser.add_argument("--helm", default=os.environ.get("HELM_BIN", "helm"))
    args = parser.parse_args()
    metadata = docker("image", "inspect", IMAGE, check=False)
    if metadata.returncode:
        docker("pull", "--platform", "linux/arm64", IMAGE, timeout=300)
        metadata = docker("image", "inspect", IMAGE)
    image = json.loads(metadata.stdout)[0]
    assert image["Architecture"] == "arm64", "ARM64 이미지만 검증한다"
    script = """import{readFileSync}from'node:fs';import{load}from'js-yaml';
const v=load(readFileSync('helm/dev/runtime/fluent-bit-values.yaml','utf8'));
process.stdout.write(JSON.stringify({config:['service','inputs','filters','outputs'].map(k=>v.config[k]).join('\\n'),env:v.env}));"""
    actual = json.loads(command(["node", "--input-type=module", "-e", script]).stdout)
    rendered_events = command([args.helm, "template", "observability", "helm/observability/pulsemetry-observability",
                               "-n", "pulsemetry-observability", "--kube-version", "1.36.0",
                               "-f", "helm/observability/tests/generated-values.yaml", "--show-only", "templates/events.yaml"]).stdout
    extract_events = """import{loadAll}from'js-yaml';let s='';for await(const c of process.stdin)s+=c;
process.stdout.write(loadAll(s).find(x=>x?.kind==='ConfigMap'&&x.metadata.name==='kubernetes-events').data['fluent-bit.conf']);"""
    events_config = command(["node", "--input-type=module", "-e", extract_events], input=rendered_events).stdout
    test_config = """[SERVICE]
    Flush 1
    Log_Level info
    HTTP_Server On
    HTTP_Listen 0.0.0.0
    HTTP_Port 2020
    storage.path /tmp/storage
    storage.metrics On
    storage.max_chunks_up 16
[INPUT]
    Name dummy
    Alias smoke
    Dummy {"message":"fixture"}
    Rate 10
    Tag smoke
    storage.type filesystem
[OUTPUT]
    Name null
    Match *
    storage.total_limit_size 1M
"""
    name = "proj191-fluent-bit-" + uuid.uuid4().hex[:12]
    created = False
    with tempfile.TemporaryDirectory(prefix="proj191-flb-", dir="/private/tmp") as temporary:
        temp = Path(temporary)
        (temp / "runtime.conf").write_text(actual["config"])
        (temp / "events.conf").write_text(events_config)
        (temp / "smoke.conf").write_text(test_config)
        (temp / "invalid.conf").write_text(test_config.replace("Name dummy", "Name dummy\n    invalid_proj191_option true"))
        mount = ["--mount", f"type=bind,source={temp},target=/smoke,readonly"]
        env = [item for entry in actual["env"] for item in ["--env", f"{entry['name']}={entry['value']}"]]
        dry = docker("run", "--rm", "--network", "none", *mount, *env, image["Id"], "--dry-run", "--config", "/smoke/runtime.conf", check=False)
        invalid = docker("run", "--rm", "--network", "none", *mount, image["Id"], "--dry-run", "--config", "/smoke/invalid.conf", check=False)
        events = docker("run", "--rm", "--network", "none", *mount, *env, image["Id"], "--dry-run", "--config", "/smoke/events.conf", check=False)
        plugin_help = docker("run", "--rm", "--network", "none", image["Id"], "-i", "kubernetes_events", "--help").stdout
        assert dry.returncode == 0, "실제 runtime config dry-run 실패: " + dry.stderr[-2000:]
        assert events.returncode == 0, "실제 Events config dry-run 실패: " + events.stderr[-2000:]
        try:
            docker("run", "--detach", "--name", name, "--label", f"pulsemetry.observability-smoke={name}",
                   "--publish", "127.0.0.1::2020", *mount, image["Id"], "--config", "/smoke/smoke.conf")
            created = True
            host_port = json.loads(docker("inspect", name).stdout)[0]["NetworkSettings"]["Ports"]["2020/tcp"][0]["HostPort"]
            def get(path):
                with urllib.request.urlopen(f"http://127.0.0.1:{host_port}{path}", timeout=5) as response:
                    return response.read().decode()
            for _ in range(30):
                try:
                    info = json.loads(get("/"))
                    break
                except OSError:
                    time.sleep(1)
            else:
                raise RuntimeError("Fluent Bit HTTP endpoint 시작 실패")
            time.sleep(5)
            samples = {version: get(f"/api/{version}/metrics/prometheus") for version in ["v1", "v2"]}
            names = {key: sorted(set(re.findall(r"^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{| )", value, re.MULTILINE))) for key, value in samples.items()}
            storage = json.loads(get("/api/v1/storage"))
            assert "fluentbit_storage_fs_chunks" in names["v2"], "v2 filesystem chunk 지표 누락"
            assert "fluentbit_input_records_total" in names["v2"], "v2 input 지표 누락"
            args.output_dir.mkdir(parents=True, exist_ok=True)
            for version, sample in samples.items():
                # 비교에 불필요한 timestamp/실행별 시작 시각은 저장하지 않는다.
                prefixes = ("fluentbit_storage_", "fluentbit_output_", "fluentbit_input_storage_", "fluentbit_input_records_total")
                lines = [line for line in sample.splitlines() if line.removeprefix("# HELP ").removeprefix("# TYPE ").startswith(prefixes)]
                lines = [re.sub(r" ([-+0-9.eE]+) \d{13}$", r" \1", line) for line in lines]
                (args.output_dir / f"{version}-metrics.prom").write_text("\n".join(lines) + "\n")
            evidence = {"image": IMAGE, "imageDigests": image.get("RepoDigests", []), "architecture": "arm64",
                        "version": info["fluent-bit"]["version"], "pipeline": "dummy → null; filesystem buffering, storage.metrics On",
                        "runtimeConfigSource": "helm/dev/runtime/fluent-bit-values.yaml",
                        "runtimeConfigSha256": hashlib.sha256(actual["config"].encode()).hexdigest(),
                        "runtimeDryRunExitCode": dry.returncode, "invalidPluginPropertyDryRunExitCode": invalid.returncode,
                        "eventsConfigSha256": hashlib.sha256(events_config.encode()).hexdigest(), "eventsDryRunExitCode": events.returncode,
                        "eventsPluginHelpOptions": [name for name in ["kube_retention_time", "db", "interval_sec", "storage.type"] if name in plugin_help],
                        "storageMetricNames": {key: [name for name in values if name.startswith("fluentbit_storage_")] for key, values in names.items()},
                        "v2OutputCapacityMetric": "fluentbit_output_chunk_available_capacity_percent" in names["v2"],
                        "v1StorageEndpoint": storage, "recommendedPrometheusEndpoint": "/api/v2/metrics/prometheus",
                        "scope": "로컬 plugin/runtime metrics 검증. Kubernetes metadata·실제 tail DB 재시작·CloudWatch 배송·IAM은 실행하지 않음"}
            (args.output_dir / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
            (args.output_dir / "smoke.conf").write_text(test_config)
            (args.output_dir / "events.conf").write_text(events_config)
            plugin_help = re.sub(r"\x1b\[[0-9;]*m", "", plugin_help)
            (args.output_dir / "kubernetes-events-help.txt").write_text(plugin_help)
            print(f"PASS: Fluent Bit {evidence['version']} ARM64, runtime dry-run={dry.returncode}, Events dry-run={events.returncode}, invalid plugin dry-run={invalid.returncode}, storage metrics v1={len(evidence['storageMetricNames']['v1'])} v2={len(evidence['storageMetricNames']['v2'])}")
        finally:
            if created:
                docker("rm", "--force", "--volumes", name)


if __name__ == "__main__":
    main()
