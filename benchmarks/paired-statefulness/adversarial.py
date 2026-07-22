#!/usr/bin/env python3
"""Prove that the validator rejects corrupted benchmark results."""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
from pathlib import Path
from typing import Any, Callable

SCRIPT_DIR = Path(__file__).resolve().parent


def load_validator():
    spec = importlib.util.spec_from_file_location(
        "paired_summary", SCRIPT_DIR / "summarize.py"
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load summarize.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def workload_result(value: dict[str, Any], workload: str) -> dict[str, Any]:
    return next(
        result for result in value["results"] if result["workload"] == workload
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("raw", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    validator = load_validator()
    raw = json.loads(args.raw.read_text(encoding="utf-8"))
    validator.validate(raw)

    cases: dict[str, Callable[[dict[str, Any]], None]] = {
        "missing_pair": lambda value: value["results"].pop(),
        "duplicate_microvm": lambda value: value["results"][1].update(
            microvm_id=value["results"][0]["microvm_id"]
        ),
        "cross_paired_microvm": lambda value: value["results"][0][
            "guest"
        ].update(microvm_id="microvm-wrong"),
        "missing_suspension": lambda value: value["results"][0][
            "lifecycle"
        ].update(suspend_to_suspended_ms=0),
        "unverified_sample": lambda value: value["results"][0]["guest"][
            "samples"
        ][1].update(verified=False),
        "unterminated_lane": lambda value: value["results"][0].update(
            terminated=False
        ),
        "fresh_docker_cache": lambda value: workload_result(value, "docker")[
            "guest"
        ]["samples"][0]["proof"].update(buildkit_cached_steps=1),
        "changed_docker_image": lambda value: workload_result(value, "docker")[
            "guest"
        ]["samples"][1]["proof"].update(image_id="sha256:changed"),
        "changed_npm_tree": lambda value: workload_result(value, "npm")[
            "guest"
        ]["samples"][1]["proof"].update(installed_package_count=1),
        "changed_rails_bundle": lambda value: workload_result(value, "rails")[
            "guest"
        ]["samples"][1]["proof"].update(bundle_bytes=1),
        "changed_dotnet_assets": lambda value: workload_result(value, "dotnet")[
            "guest"
        ]["samples"][1]["proof"].update(assets_sha256="changed"),
    }
    outcomes: list[dict[str, str]] = []
    for name, mutate in cases.items():
        corrupted = copy.deepcopy(raw)
        mutate(corrupted)
        try:
            validator.validate(corrupted)
        except ValueError as error:
            outcomes.append(
                {"case": name, "outcome": "rejected", "reason": str(error)}
            )
        else:
            raise RuntimeError(f"validator accepted corruption: {name}")
    result = {
        "schema_version": 1,
        "run_id": raw["manifest"]["run_id"],
        "baseline": "accepted",
        "case_count": len(outcomes),
        "all_corruptions_rejected": True,
        "cases": outcomes,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
