from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def load(name: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


summarize_module = load("summarize")


def valid_raw(count: int = 3):
    results = []
    for workload_index, workload in enumerate(summarize_module.WORKLOADS):
        for lane in range(1, count + 1):
            microvm_id = f"microvm-{workload_index}-{lane}"
            results.append(
                {
                    "workload": workload,
                    "lane_id": f"lane-{lane:03d}",
                    "microvm_id": microvm_id,
                    "terminated": True,
                    "lifecycle": {
                        "suspend_to_suspended_ms": 100,
                        "resume_to_running_ms": 200,
                    },
                    "guest": {
                        "workload": workload,
                        "lane_id": f"lane-{lane:03d}",
                        "microvm_id": microvm_id,
                        "samples": [
                            {
                                "phase": "fresh",
                                "duration_ms": 1000 + lane,
                                "verified": True,
                            },
                            {
                                "phase": "resumed",
                                "duration_ms": 100 + lane,
                                "verified": True,
                            },
                        ],
                    },
                }
            )
    return {
        "manifest": {
            "run_id": "test-run",
            "sample_count_per_workload": count,
            "workloads": list(summarize_module.WORKLOADS),
        },
        "results": results,
        "failures": [],
    }


class SummaryTests(unittest.TestCase):
    def test_valid_run_is_summarized(self):
        summary = summarize_module.summarize(valid_raw())
        self.assertEqual(summary["workloads"]["docker"]["fresh"]["count"], 3)
        self.assertGreater(
            summary["workloads"]["docker"]["paired"][
                "median_fresh_over_resumed_ratio"
            ],
            9,
        )

    def assert_rejected(self, mutation):
        value = valid_raw()
        mutation(value)
        with self.assertRaises(ValueError):
            summarize_module.validate(value)

    def test_rejects_missing_sample(self):
        self.assert_rejected(lambda value: value["results"].pop())

    def test_rejects_duplicate_microvm(self):
        self.assert_rejected(
            lambda value: value["results"][1].update(
                microvm_id=value["results"][0]["microvm_id"]
            )
        )

    def test_rejects_cross_pair(self):
        self.assert_rejected(
            lambda value: value["results"][0]["guest"].update(
                microvm_id="microvm-wrong"
            )
        )

    def test_rejects_changed_phase(self):
        self.assert_rejected(
            lambda value: value["results"][0]["guest"]["samples"][1].update(
                phase="fresh"
            )
        )

    def test_rejects_unverified_sample(self):
        self.assert_rejected(
            lambda value: value["results"][0]["guest"]["samples"][1].update(
                verified=False
            )
        )

    def test_rejects_unterminated_lane(self):
        self.assert_rejected(
            lambda value: value["results"][0].update(terminated=False)
        )

    def test_bootstrap_is_reproducible(self):
        values = [1.0, 2.0, 3.0, 4.0]
        first = summarize_module.bootstrap_median_interval(
            values, iterations=200
        )
        second = summarize_module.bootstrap_median_interval(
            copy.copy(values), iterations=200
        )
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
