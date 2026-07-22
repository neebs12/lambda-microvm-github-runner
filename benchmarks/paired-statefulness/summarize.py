#!/usr/bin/env python3
"""Validate and summarize the paired statefulness benchmark."""

from __future__ import annotations

import argparse
import json
import math
import random
import statistics
from pathlib import Path
from typing import Any

WORKLOADS = ("docker", "npm", "rails", "dotnet")


def nearest_rank(values: list[float], percentile: float) -> float:
    if not values:
        raise ValueError("percentile requires values")
    ordered = sorted(values)
    rank = max(1, math.ceil(percentile * len(ordered)))
    return ordered[rank - 1]


def describe(values: list[float]) -> dict[str, float | int]:
    return {
        "count": len(values),
        "mean_ms": round(statistics.fmean(values), 3),
        "standard_deviation_ms": round(statistics.stdev(values), 3)
        if len(values) > 1
        else 0.0,
        "p50_ms": round(nearest_rank(values, 0.50), 3),
        "p90_ms": round(nearest_rank(values, 0.90), 3),
        "min_ms": round(min(values), 3),
        "max_ms": round(max(values), 3),
    }


def bootstrap_median_interval(
    values: list[float], *, iterations: int = 20_000, seed: int = 20260723
) -> dict[str, float | int]:
    generator = random.Random(seed)
    medians = sorted(
        statistics.median(generator.choices(values, k=len(values)))
        for _ in range(iterations)
    )
    return {
        "iterations": iterations,
        "seed": seed,
        "lower_95": round(nearest_rank(medians, 0.025), 6),
        "upper_95": round(nearest_rank(medians, 0.975), 6),
    }


def validate(raw: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    if raw.get("failures"):
        raise ValueError(f"run contains failures: {raw['failures']}")
    manifest = raw.get("manifest", {})
    expected_count = int(manifest.get("sample_count_per_workload", 0))
    expected_workloads = tuple(manifest.get("workloads", []))
    if expected_count < 1:
        raise ValueError("invalid expected sample count")
    if not expected_workloads or any(item not in WORKLOADS for item in expected_workloads):
        raise ValueError("invalid workload set")
    grouped: dict[str, list[dict[str, Any]]] = {
        workload: [] for workload in expected_workloads
    }
    all_ids: set[str] = set()
    all_lanes: set[str] = set()
    for result in raw.get("results", []):
        workload = result.get("workload")
        if workload not in grouped:
            raise ValueError(f"unexpected workload: {workload}")
        lane_key = f"{workload}/{result.get('lane_id')}"
        if lane_key in all_lanes:
            raise ValueError(f"duplicate lane: {lane_key}")
        all_lanes.add(lane_key)
        microvm_id = result.get("microvm_id")
        if not microvm_id or microvm_id in all_ids:
            raise ValueError(f"missing or reused MicroVM ID: {microvm_id}")
        all_ids.add(microvm_id)
        if not result.get("terminated"):
            raise ValueError(f"unterminated lane: {lane_key}")
        lifecycle = result.get("lifecycle", {})
        if float(lifecycle.get("suspend_to_suspended_ms", 0)) <= 0:
            raise ValueError(f"missing suspension: {lane_key}")
        if float(lifecycle.get("resume_to_running_ms", 0)) <= 0:
            raise ValueError(f"missing resume: {lane_key}")
        guest = result.get("guest", {})
        if guest.get("microvm_id") != microvm_id:
            raise ValueError(f"cross-paired MicroVM: {lane_key}")
        if guest.get("workload") != workload or guest.get("lane_id") != result.get("lane_id"):
            raise ValueError(f"guest identity mismatch: {lane_key}")
        samples = guest.get("samples", [])
        if [sample.get("phase") for sample in samples] != ["fresh", "resumed"]:
            raise ValueError(f"incomplete sample pair: {lane_key}")
        if not all(sample.get("verified") for sample in samples):
            raise ValueError(f"unverified pair: {lane_key}")
        if not all(float(sample.get("duration_ms", 0)) > 0 for sample in samples):
            raise ValueError(f"invalid duration: {lane_key}")
        fresh_proof = samples[0].get("proof", {})
        resumed_proof = samples[1].get("proof", {})
        if workload == "docker":
            if fresh_proof.get("buildkit_cached_steps") != 0:
                raise ValueError(f"fresh Docker cache was not empty: {lane_key}")
            if int(resumed_proof.get("buildkit_cached_steps", 0)) < 1:
                raise ValueError(f"resumed Docker cache was unused: {lane_key}")
            if (
                fresh_proof.get("image_id") != resumed_proof.get("image_id")
                or fresh_proof.get("output") != resumed_proof.get("output")
            ):
                raise ValueError(f"Docker output identity changed: {lane_key}")
        elif workload == "npm":
            fresh_count = int(fresh_proof.get("installed_package_count", 0))
            resumed_count = int(
                resumed_proof.get("installed_package_count", 0)
            )
            if fresh_count < 50 or fresh_count != resumed_count:
                raise ValueError(f"npm dependency tree changed: {lane_key}")
        elif workload == "rails":
            if (
                fresh_proof.get("rails_version")
                != resumed_proof.get("rails_version")
                or int(fresh_proof.get("bundle_bytes", 0)) < 1
                or fresh_proof.get("bundle_bytes")
                != resumed_proof.get("bundle_bytes")
            ):
                raise ValueError(f"Rails bundle identity changed: {lane_key}")
        elif workload == "dotnet":
            if (
                int(fresh_proof.get("assets_file_count", 0)) < 15
                or fresh_proof.get("assets_file_count")
                != resumed_proof.get("assets_file_count")
                or fresh_proof.get("assets_sha256")
                != resumed_proof.get("assets_sha256")
                or int(fresh_proof.get("nuget_packages_bytes", 0)) < 1
                or fresh_proof.get("nuget_packages_bytes")
                != resumed_proof.get("nuget_packages_bytes")
            ):
                raise ValueError(f".NET restore identity changed: {lane_key}")
        grouped[workload].append(result)
    for workload, results in grouped.items():
        if len(results) != expected_count:
            raise ValueError(
                f"{workload} has {len(results)} pairs, expected {expected_count}"
            )
        expected_lanes = {
            f"lane-{index:03d}" for index in range(1, expected_count + 1)
        }
        actual_lanes = {result["lane_id"] for result in results}
        if actual_lanes != expected_lanes:
            raise ValueError(f"{workload} lane set mismatch")
    return grouped


def summarize(raw: dict[str, Any]) -> dict[str, Any]:
    grouped = validate(raw)
    workloads: dict[str, Any] = {}
    for workload, results in grouped.items():
        ordered = sorted(results, key=lambda result: result["lane_id"])
        fresh = [float(item["guest"]["samples"][0]["duration_ms"]) for item in ordered]
        resumed = [float(item["guest"]["samples"][1]["duration_ms"]) for item in ordered]
        differences = [fresh_value - resumed_value for fresh_value, resumed_value in zip(fresh, resumed)]
        ratios = [fresh_value / resumed_value for fresh_value, resumed_value in zip(fresh, resumed)]
        workloads[workload] = {
            "fresh": describe(fresh),
            "resumed": describe(resumed),
            "paired": {
                "median_difference_ms": round(statistics.median(differences), 3),
                "median_fresh_over_resumed_ratio": round(statistics.median(ratios), 6),
                "ratio_bootstrap_95_ci": bootstrap_median_interval(ratios),
            },
            "pairs": [
                {
                    "lane_id": item["lane_id"],
                    "microvm_id": item["microvm_id"],
                    "fresh_ms": fresh[index],
                    "resumed_ms": resumed[index],
                    "difference_ms": round(differences[index], 3),
                    "fresh_over_resumed_ratio": round(ratios[index], 6),
                }
                for index, item in enumerate(ordered)
            ],
        }
    return {
        "schema_version": 1,
        "run_id": raw["manifest"]["run_id"],
        "replication_unit": "one MicroVM fresh/resumed pair",
        "workloads": workloads,
    }


def report(summary: dict[str, Any]) -> str:
    lines = [
        "# Fresh versus resumed MicroVM statefulness benchmark",
        "",
        f"Run ID: `{summary['run_id']}`",
        "",
        "Each workload uses 30 independent MicroVMs. Every MicroVM runs the",
        "workload once fresh, suspends, resumes, and runs the exact workload once",
        "more. Docker is the primary result.",
        "",
        "## Results",
        "",
        "| Workload | Fresh p50 | Fresh p90 | Resumed p50 | Resumed p90 | Paired median speedup |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for workload in WORKLOADS:
        if workload not in summary["workloads"]:
            continue
        item = summary["workloads"][workload]
        lines.append(
            f"| {workload} | {item['fresh']['p50_ms'] / 1000:.2f}s | "
            f"{item['fresh']['p90_ms'] / 1000:.2f}s | "
            f"{item['resumed']['p50_ms'] / 1000:.2f}s | "
            f"{item['resumed']['p90_ms'] / 1000:.2f}s | "
            f"{item['paired']['median_fresh_over_resumed_ratio']:.2f}x |"
        )
    lines.extend(
        [
            "",
            "The ratio is fresh duration divided by resumed duration for the same",
            "MicroVM, then the median across the 30 pairs. The report applies no",
            "outlier removal or arbitrary performance threshold. At n=30, p90 is",
            "descriptive rather than a high-confidence tail estimate.",
            "",
            "## Docker paired observations",
            "",
            "| Lane | Fresh | Resumed | Fresh/resumed |",
            "| --- | ---: | ---: | ---: |",
        ]
    )
    docker = summary["workloads"].get("docker", {"pairs": []})
    for pair in docker["pairs"]:
        lines.append(
            f"| {pair['lane_id']} | {pair['fresh_ms'] / 1000:.2f}s | "
            f"{pair['resumed_ms'] / 1000:.2f}s | "
            f"{pair['fresh_over_resumed_ratio']:.2f}x |"
        )
    lines.extend(
        [
            "",
            "## Interpretation boundaries",
            "",
            "- Docker preserves normal BuildKit layers and its base-image state.",
            "- npm removes `node_modules` before each run and preserves only npm's",
            "  normal download cache.",
            "- Bundler preserves installed production gems and normal bundle state.",
            "- .NET preserves its NuGet global packages and normal project restore",
            "  state.",
            "- Container-runtime image pulls for npm, Bundler, and .NET occur during",
            "  untimed setup. Dockerfile base pulls remain part of the Docker build.",
            "",
            "See `raw.json` and `summary.json` for every observation and correctness",
            "proof. Lifecycle timing is recorded separately from workload duration.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw", type=Path)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    raw = json.loads(args.raw.read_text(encoding="utf-8"))
    value = summarize(raw)
    args.summary.parent.mkdir(parents=True, exist_ok=True)
    args.summary.write_text(
        json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    args.report.write_text(report(value), encoding="utf-8")


if __name__ == "__main__":
    main()
