#!/usr/bin/env python3
"""Aggregate raw warm-build benchmark samples with nearest-rank percentiles."""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path
from typing import Any


def percentile(values: list[float], proportion: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(proportion * len(ordered)) - 1)]


def statistics_for(values: list[float]) -> dict[str, float | int]:
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
    baseline: dict[str, float | int],
    candidate: dict[str, float | int],
) -> dict[str, float]:
    baseline_p50 = float(baseline["p50_ms"])
    candidate_p50 = float(candidate["p50_ms"])
    return {
        "baseline_p50_ms": baseline_p50,
        "candidate_p50_ms": candidate_p50,
        "p50_speedup": round(baseline_p50 / candidate_p50, 2),
        "p50_time_reduction_percent": round(
            (1 - candidate_p50 / baseline_p50) * 100, 1
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw_results", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    raw: dict[str, Any] = json.loads(
        args.raw_results.read_text(encoding="utf-8")
    )
    servers = raw["servers"]
    sample_names = sorted(servers[0]["samples"])
    aggregate: dict[str, dict[str, float | int]] = {}
    per_server: dict[str, dict[str, dict[str, float | int]]] = {}
    for sample_name in sample_names:
        combined: list[float] = []
        for server in servers:
            values = [float(value) for value in server["samples"][sample_name]]
            if values:
                combined.extend(values)
                per_server.setdefault(server["server_id"], {})[
                    sample_name
                ] = statistics_for(values)
        if combined:
            aggregate[sample_name] = statistics_for(combined)

    post_resume_first = [
        float(server["samples"]["post_resume_exact_build_ms"][0])
        for server in servers
    ]
    post_resume_steady = [
        float(value)
        for server in servers
        for value in server["samples"]["post_resume_exact_build_ms"][1:]
    ]
    aggregate["post_resume_first_exact_build_ms"] = statistics_for(
        post_resume_first
    )
    if post_resume_steady:
        aggregate["post_resume_steady_exact_build_ms"] = statistics_for(
            post_resume_steady
        )

    for control_name in (
        "cold_provision_to_running_ms",
        "suspend_to_suspended_ms",
        "resume_to_running_ms",
    ):
        values = [
            float(server["control_plane"][control_name]) for server in servers
        ]
        aggregate[control_name] = statistics_for(values)

    comparisons = {
        "docker_cold_to_warm_exact": comparison(
            aggregate["docker_cold_build_ms"],
            aggregate["docker_warm_exact_build_ms"],
        ),
        "docker_cold_to_changed_source": comparison(
            aggregate["docker_cold_build_ms"],
            aggregate["docker_changed_source_build_ms"],
        ),
        "npm_cold_to_warm": comparison(
            aggregate["npm_cold_install_ms"],
            aggregate["npm_warm_install_ms"],
        ),
        "typescript_cold_to_incremental": comparison(
            aggregate["typescript_cold_artifact_build_ms"],
            aggregate["typescript_incremental_artifact_build_ms"],
        ),
    }
    if post_resume_steady:
        comparisons["docker_cold_to_post_resume_steady"] = comparison(
            aggregate["docker_cold_build_ms"],
            aggregate["post_resume_steady_exact_build_ms"],
        )

    summary = {
        "schema_version": 1,
        "method": "nearest-rank percentiles",
        "server_count": len(servers),
        "aggregate": aggregate,
        "comparisons": comparisons,
        "per_server": per_server,
    }
    text = json.dumps(summary, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(text, encoding="utf-8")
    print(text, end="")


if __name__ == "__main__":
    main()
