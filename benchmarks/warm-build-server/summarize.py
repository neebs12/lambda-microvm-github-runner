#!/usr/bin/env python3
"""Summarize fresh-versus-resumed exact-job benchmark samples."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any

METRICS = (
    "docker_build_ms",
    "npm_install_ms",
    "typescript_build_ms",
    "job_total_ms",
)


def percentile(values: list[float], proportion: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(proportion * len(ordered)) - 1)]


def statistics_for(values: list[float]) -> dict[str, float | int]:
    if not values:
        raise ValueError("cannot summarize an empty sample")
    return {
        "n": len(values),
        "min_ms": round(min(values), 3),
        "p50_ms": round(percentile(values, 0.50), 3),
        "p90_ms": round(percentile(values, 0.90), 3),
        "p95_ms": round(percentile(values, 0.95), 3),
        "max_ms": round(max(values), 3),
        "mean_ms": round(statistics.fmean(values), 3),
    }


def comparison(
    fresh: dict[str, float | int], resumed: dict[str, float | int]
) -> dict[str, float]:
    fresh_p50 = float(fresh["p50_ms"])
    resumed_p50 = float(resumed["p50_ms"])
    return {
        "fresh_p50_ms": fresh_p50,
        "resumed_p50_ms": resumed_p50,
        "p50_speedup": round(fresh_p50 / resumed_p50, 2),
        "p50_time_reduction_percent": round(
            (1 - resumed_p50 / fresh_p50) * 100, 1
        ),
    }


def job_metric(job: dict[str, Any], metric: str) -> float:
    return float(job["timings"][metric])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw_results", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    raw: dict[str, Any] = json.loads(
        args.raw_results.read_text(encoding="utf-8")
    )
    if raw.get("schema_version") != 2:
        raise ValueError("expected exact-job raw schema version 2")
    servers = raw["servers"]
    if not servers:
        raise ValueError("raw results contain no servers")

    fresh_jobs: list[dict[str, Any]] = []
    resumed_jobs: list[dict[str, Any]] = []
    per_cycle_jobs: dict[int, list[dict[str, Any]]] = {}
    per_server: dict[str, Any] = {}
    input_hashes: set[str] = set()
    verified_jobs = 0

    for server in servers:
        jobs = server["jobs"]
        server_fresh = [job for job in jobs if job["kind"] == "fresh"]
        server_resumed = [job for job in jobs if job["kind"] == "resumed"]
        if len(server_fresh) != 1:
            raise ValueError(
                f"{server['server_id']} has {len(server_fresh)} fresh jobs"
            )
        expected_cycles = list(
            range(1, raw["configuration"]["resumed_cycles_per_server"] + 1)
        )
        observed_cycles = sorted(int(job["cycle"]) for job in server_resumed)
        if observed_cycles != expected_cycles:
            raise ValueError(
                f"{server['server_id']} cycles {observed_cycles} "
                f"do not match {expected_cycles}"
            )
        fresh_jobs.extend(server_fresh)
        resumed_jobs.extend(server_resumed)
        for job in jobs:
            input_hashes.add(str(job["input_tree_sha256"]))
            verified_jobs += int(bool(job["verified"]))
            if job["kind"] == "resumed":
                per_cycle_jobs.setdefault(int(job["cycle"]), []).append(job)

        metrics: dict[str, Any] = {}
        for metric in METRICS:
            fresh_value = job_metric(server_fresh[0], metric)
            resumed_values = [
                job_metric(job, metric) for job in server_resumed
            ]
            resumed_statistics = statistics_for(resumed_values)
            metrics[metric] = {
                "fresh_ms": round(fresh_value, 3),
                "resumed": resumed_statistics,
                "fresh_to_resumed_median_speedup": round(
                    fresh_value / float(resumed_statistics["p50_ms"]), 2
                ),
            }
        per_server[server["server_id"]] = {"metrics": metrics}

    configured_fresh = int(raw["configuration"]["fresh_sample_count"])
    configured_resumed = int(raw["configuration"]["resumed_sample_count"])
    if len(fresh_jobs) != configured_fresh:
        raise ValueError(
            f"expected {configured_fresh} fresh samples, found {len(fresh_jobs)}"
        )
    if len(resumed_jobs) != configured_resumed:
        raise ValueError(
            "expected "
            f"{configured_resumed} resumed samples, found {len(resumed_jobs)}"
        )
    if verified_jobs != len(fresh_jobs) + len(resumed_jobs):
        raise ValueError("one or more benchmark jobs failed verification")
    if len(input_hashes) != 1:
        raise ValueError(f"benchmark used multiple input trees: {input_hashes}")

    aggregate: dict[str, Any] = {}
    comparisons: dict[str, Any] = {}
    by_cycle: dict[str, Any] = {}
    for metric in METRICS:
        fresh_statistics = statistics_for(
            [job_metric(job, metric) for job in fresh_jobs]
        )
        resumed_statistics = statistics_for(
            [job_metric(job, metric) for job in resumed_jobs]
        )
        aggregate[metric] = {
            "fresh": fresh_statistics,
            "resumed": resumed_statistics,
        }
        comparisons[metric] = comparison(
            fresh_statistics, resumed_statistics
        )
        by_cycle[metric] = {
            str(cycle): statistics_for(
                [job_metric(job, metric) for job in jobs]
            )
            for cycle, jobs in sorted(per_cycle_jobs.items())
        }

    control_metrics = {
        "provision_to_running_ms": [
            float(server["control_plane"]["fresh"]["provision_to_running_ms"])
            for server in servers
        ],
        "provision_to_job_complete_ms": [
            float(
                server["control_plane"]["fresh"][
                    "provision_to_job_complete_ms"
                ]
            )
            for server in servers
        ],
        "fresh_suspend_to_suspended_ms": [
            float(
                server["control_plane"]["fresh"][
                    "suspend_to_suspended_ms"
                ]
            )
            for server in servers
        ],
        "resume_to_running_ms": [
            float(cycle["resume_to_running_ms"])
            for server in servers
            for cycle in server["control_plane"]["resumed_cycles"]
        ],
        "resume_to_job_complete_ms": [
            float(cycle["resume_to_job_complete_ms"])
            for server in servers
            for cycle in server["control_plane"]["resumed_cycles"]
        ],
        "resumed_suspend_to_suspended_ms": [
            float(cycle["suspend_to_suspended_ms"])
            for server in servers
            for cycle in server["control_plane"]["resumed_cycles"]
        ],
        "suspended_dwell_ms": [
            float(cycle["suspended_dwell_ms"])
            for server in servers
            for cycle in server["control_plane"]["resumed_cycles"]
        ],
    }

    summary = {
        "schema_version": 2,
        "method": "nearest-rank percentiles",
        "server_count": len(servers),
        "fresh_sample_count": len(fresh_jobs),
        "resumed_sample_count": len(resumed_jobs),
        "input_tree_sha256": next(iter(input_hashes)),
        "verified_job_count": verified_jobs,
        "aggregate": aggregate,
        "comparisons": comparisons,
        "resumed_by_cycle": by_cycle,
        "control_plane": {
            name: statistics_for(values)
            for name, values in control_metrics.items()
        },
        "per_server": per_server,
    }
    text = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
