#!/usr/bin/env python3
"""AWS 없이 고정 ARM64 k6/Prometheus의 native histogram 연결을 검증한다."""
import argparse
import hashlib
import json
import math
import pathlib
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
PROMETHEUS = "quay.io/prometheus/prometheus:v3.9.1@sha256:1f0f50f06acaceb0f5670d2c8a658a599affe7b0d8e78b898c1035653849a702"
K6 = "grafana/k6:1.8.2@sha256:bd6ae8607c0a05d0dc0dc3f5753c464b0929baf083ef0f20b7eed845a3d9e6b4"


def docker(*args):
    return subprocess.run(["docker", *args], check=True, text=True, capture_output=True).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        parser.error("기존 증거를 덮어쓰지 않는다. 새 output 경로를 사용한다.")
    suffix = uuid.uuid4().hex[:12]
    network = f"proj191-rw-{suffix}"
    prom_name = f"{network}-prometheus"
    testid = f"observability-smoke/{suffix}"
    containers = [prom_name]
    workers = []
    created_network = False
    started = time.time()
    evidence = {"scope": "local-remote-write-compatibility-only", "testid": testid, "status": "NOT_RUN"}
    try:
        images = {}
        for image in (PROMETHEUS, K6):
            docker("pull", "--platform", "linux/arm64", image)
            metadata = json.loads(docker("image", "inspect", image))[0]
            assert metadata["Architecture"] == "arm64", image
            images[image] = {"architecture": metadata["Architecture"], "digests": metadata["RepoDigests"]}
        evidence["images"] = images
        docker("network", "create", network)
        created_network = True
        with tempfile.TemporaryDirectory(prefix="proj191-prometheus-") as tmp:
            config = pathlib.Path(tmp) / "prometheus.yaml"
            config.write_text("global:\n  scrape_interval: 10s\n  evaluation_interval: 10s\nscrape_configs: []\n")
            docker("run", "-d", "--name", prom_name, "--network", network, "--network-alias", "prometheus",
                   "--platform", "linux/arm64", "--memory", "512m", "--cpus", "1",
                   "-p", "127.0.0.1::9090", "--tmpfs", "/prometheus:size=268435456,mode=777",
                   "-v", f"{config}:/etc/prometheus/prometheus.yaml:ro", PROMETHEUS,
                   "--config.file=/etc/prometheus/prometheus.yaml", "--storage.tsdb.path=/prometheus",
                   "--web.enable-remote-write-receiver")
            address = docker("port", prom_name, "9090/tcp").splitlines()[0]
            base = f"http://{address}"
            deadline = time.monotonic() + 30
            while True:
                try:
                    with urllib.request.urlopen(base + "/-/ready", timeout=2) as response:
                        if response.status == 200:
                            break
                except (OSError, urllib.error.URLError):
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError("Prometheus readiness timeout")
                time.sleep(0.2)
            fixture = ROOT / "helm/observability/tests/remote-write/smoke.js"
            evidence["fixture_sha256"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
            evidence["verifier_sha256"] = hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()
            for generator in ("fast", "slow"):
                name = f"{network}-{generator}"
                containers.append(name)
                command = ["docker", "run", "--rm", "--name", name, "--network", network,
                           "--platform", "linux/arm64", "--memory", "256m", "--cpus", "0.5",
                           "-v", f"{fixture}:/smoke.js:ro",
                           "-e", "K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write",
                           "-e", "K6_PROMETHEUS_RW_PUSH_INTERVAL=5s",
                           "-e", "K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true",
                           "-e", "K6_PROMETHEUS_RW_STALE_MARKERS=true", "-e", f"GENERATOR_ID={generator}",
                           K6, "run", "--quiet", "-o", "experimental-prometheus-rw",
                           "--tag", f"testid={testid}", "--tag", "environment=local-smoke",
                           "--tag", "cluster=local-smoke",
                           "--tag", f"generator_id={generator}", "/smoke.js"]
                workers.append(subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
            for worker in workers:
                out, err = worker.communicate(timeout=45)
                if worker.returncode:
                    raise RuntimeError(f"k6 exited {worker.returncode}: {out[-2000:]} {err[-2000:]}")
                if "Failed to send" in err or 'level=error' in err:
                    raise RuntimeError(f"k6 remote-write error: {err[-2000:]}")

            def query(expression):
                url = base + "/api/v1/query?" + urllib.parse.urlencode({"query": expression})
                with urllib.request.urlopen(url, timeout=5) as response:
                    data = json.load(response)
                assert data["status"] == "success", data
                assert not data.get("warnings"), data
                return data["data"]["result"]

            # 종료 stale marker를 0으로 채우지 않고 직전 window의 histogram을 조회한다.
            source = f'last_over_time(k6_contract_latency_seconds{{testid="{testid}"}}[1m])'
            histograms = query(source)
            assert {r["metric"]["generator_id"] for r in histograms} == {"fast", "slow"}, histograms
            assert all(r["metric"].get("cluster") == "local-smoke" for r in histograms), histograms
            assert all("histogram" in r for r in histograms), histograms
            count = sum(float(r["histogram"][1]["count"]) for r in histograms)
            merged_count = query(f"histogram_count(sum({source}))")
            assert float(merged_count[0]["value"][1]) == count and count > 100, merged_count
            merged_p95 = float(query(f"histogram_quantile(0.95,sum({source}))")[0]["value"][1])
            assert math.isfinite(merged_p95) and 0.16 < merged_p95 < 0.25, merged_p95
            http_histograms = query(f'last_over_time(k6_http_req_duration_seconds{{testid="{testid}"}}[1m])')
            assert http_histograms and all("histogram" in r for r in http_histograms), http_histograms
            assert not query(f'k6_contract_latency_seconds{{testid="{testid}"}}'), "종료 stale marker를 확인하지 못했다"
            evidence.update(status="PASS", generator_ids=["fast", "slow"], sample_count=count,
                            merged_p95_seconds=merged_p95, native_http_histogram_series=len(http_histograms),
                            stale_markers_verified=True, push_interval_seconds=5, prometheus_scrape_interval_seconds=10)
    except Exception as failure:
        evidence.update(status="FAIL", error=str(failure))
        raise
    finally:
        for worker in workers:
            if worker.poll() is None:
                worker.terminate()
        for name in containers:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        if created_network:
            subprocess.run(["docker", "network", "rm", network], capture_output=True)
        evidence.update(started_at_unix=started, finished_at_unix=time.time())
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
