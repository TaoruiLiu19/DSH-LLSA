"""Compare CLI replay and drift repair with a prewritten Python CSV script.

Run from the project root with python -B tests/benchmark.py --rows 10000 100000 --runs 5.
"""

import argparse
import csv
import json
import statistics
import subprocess
import sys
import tempfile
from pathlib import Path
from time import perf_counter


HERE = Path(__file__).resolve().parent
PLUGIN = HERE.parent / "plugins" / "task-reuse" / "task_reuse.py"
REFERENCE = HERE / "reference_dedupe.py"
RULE = "attendance"
TIME_COLUMN = "报名时间"
RENAMED_TIME = "提交时间"


def subprocess_run(script, *arguments, exit_code=0):
    result = subprocess.run(
        [sys.executable, "-B", str(script), *arguments],
        capture_output=True, encoding="utf-8", timeout=60,
    )
    if result.returncode != exit_code:
        raise RuntimeError(f"{script.name} exited with {result.returncode}: {result.stdout}\n{result.stderr}")
    return result.stdout


def plugin(workspace, *arguments, exit_code=0):
    return json.loads(subprocess_run(PLUGIN, "--workspace", str(workspace), *arguments, exit_code=exit_code))


def write_input(path, count, time_column, batch):
    distinct = (count + 1) // 2
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["邮箱", time_column, "姓名"])
        for index in range(distinct):
            writer.writerow([f"person-{index}@example.invalid", "2026-11-02T01:00:00+08:00", f"批次 {batch} 的最新记录 {index}"])
        for index in range(count - distinct):
            writer.writerow([f" PERSON-{index}@EXAMPLE.invalid ", "2026-11-01T16:00:00Z", f"批次 {batch} 的旧记录 {index}"])


def seed_recipe(workspace):
    seed = workspace / "seed.csv"
    write_input(seed, 2, TIME_COLUMN, "seed")
    preview = plugin(workspace, "preview", seed.name, "--key", "邮箱", "--keep", "latest_timestamp", "--time-column", TIME_COLUMN)
    return plugin(workspace, "apply", preview["plan_id"], "--save-as", RULE)


def replay(workspace, source):
    return plugin(workspace, "run", RULE, "--input", source.name)


def repair(workspace, source):
    drift = plugin(workspace, "run", RULE, "--input", source.name, exit_code=2)
    if drift["status"] != "needs_binding" or drift["missing_columns"] != [TIME_COLUMN]:
        raise AssertionError(f"Incorrect drift diagnosis: {drift}")
    preview = plugin(workspace, "preview", source.name, "--recipe", RULE, "--replacement", RENAMED_TIME)
    return plugin(workspace, "apply", preview["plan_id"])


def elapsed(action):
    start = perf_counter()
    result = action()
    return (perf_counter() - start) * 1000, result


def summary(samples):
    return {"median_ms": round(statistics.median(samples), 1), "samples_ms": [round(value, 1) for value in samples]}


def measure(workspace, count, runs, *, drift):
    time_column = RENAMED_TIME if drift else TIME_COLUMN
    command = repair if drift else replay
    plugin_times, reference_times = [], []
    for index in range(runs):
        stem = f"{'drift' if drift else 'repeat'}-{count}-{index}"
        source = workspace / f"{stem}.csv"
        target = workspace / f"{stem}-reference.csv"
        write_input(source, count, time_column, index)

        def run_plugin():
            return command(workspace, source)

        def run_reference():
            subprocess_run(REFERENCE, str(source), str(target), time_column)

        if index % 2:
            reference_ms, _ = elapsed(run_reference)
            plugin_ms, receipt = elapsed(run_plugin)
        else:
            plugin_ms, receipt = elapsed(run_plugin)
            reference_ms, _ = elapsed(run_reference)
        if receipt["status"] != "completed" or receipt["model_calls"] != 0:
            raise AssertionError(f"Unexpected receipt: {receipt}")
        if receipt["output_rows"] != (count + 1) // 2 or Path(receipt["output_path"]).read_bytes() != target.read_bytes():
            raise AssertionError(f"Outputs differ for {stem}")
        plugin_times.append(plugin_ms)
        reference_times.append(reference_ms)
    return {
        "input_rows": count, "scenario": "drift_repair" if drift else "replay",
        "task_reuse": summary(plugin_times), "prewritten_python": summary(reference_times),
        "byte_identical_runs": runs, "executor_model_calls": 0,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, nargs="+", default=[10_000, 100_000])
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--replay-only", action="store_true")
    args = parser.parse_args()
    if args.runs < 1 or any(not 2 <= count <= 100_000 for count in args.rows):
        parser.error("runs must be positive and each row count must be between 2 and 100000")

    with tempfile.TemporaryDirectory(prefix="task-reuse-benchmark-", dir=HERE) as folder:
        workspace = Path(folder)
        seed_ms, _ = elapsed(lambda: seed_recipe(workspace))
        cases = [measure(workspace, count, args.runs, drift=False) for count in args.rows]
        if not args.replay_only:
            cases.extend(measure(workspace, count, args.runs, drift=True) for count in args.rows)
    print(json.dumps({
        "recipe_seed_ms": round(seed_ms, 1),
        "method": "Wall time includes Python startup, CLI calls and artifact writing. Synthetic fixture creation, human decision time and output comparison are excluded.",
        "reference_scope": "The prewritten script has explicit column names and handles the same valid fixture. It omits recipe history, content-drift detection, receipt generation and independent verification.",
        "cases": cases,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
