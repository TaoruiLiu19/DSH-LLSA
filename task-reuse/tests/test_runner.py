import csv
import json
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path
import sys


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "task-reuse"
sys.path.insert(0, str(PLUGIN))

from task_reuse import Runner, TaskError


HEADER = ["邮箱", "报名时间", "姓名"]
SAMPLE_ROWS = [
    [" First@example.invalid ", "2026-11-01T11:00:00+08:00", "阿甲, 备注"],
    ["other@example.invalid", "2026-11-01T09:00:00+08:00", "阿乙\n换行"],
    ["first@EXAMPLE.invalid", "2026-11-01T10:00:00+08:00", "阿丙"],
]


def write_csv(path, header, rows, *, encoding="utf-8"):
    with path.open("w", encoding=encoding, newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(header)
        writer.writerows(rows)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="task-reuse-test-", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "工作区 含空格"
        self.root.mkdir()
        self.runner = Runner(self.root)
        self.source = self.root / "报名表.csv"

    def write_source(self, rows=SAMPLE_ROWS, header=HEADER, *, encoding="utf-8"):
        write_csv(self.source, header, rows, encoding=encoding)
        return self.source.name

    def inspect_source(self):
        return self.runner.inspect(self.source.name)

    def preview(self, keep, *, save_as=None):
        self.write_source()
        inspection = self.inspect_source()
        options = {"key": "邮箱", "keep": keep}
        if keep == "latest_timestamp":
            options["time_column"] = "报名时间"
        plan = self.runner.preview(inspection["input_id"], **options)
        self.assertEqual(plan["status"], "ready")
        if save_as:
            self.runner.run(plan_id=plan["plan_id"], save_as=save_as)
        return plan

    def read_result(self, result):
        output = self.root / result["output_path"]
        with output.open(encoding="utf-8-sig", newline="") as stream:
            return list(csv.reader(stream))

    def test_ambiguous_rule_returns_choices_without_leaking_rows(self):
        self.write_source(encoding="utf-8-sig")
        inspection = self.inspect_source()
        self.assertEqual(inspection["columns"], HEADER)
        self.assertEqual(inspection["row_count"], 3)
        preview = self.runner.preview(inspection["input_id"], key="邮箱")
        self.assertEqual(preview["status"], "needs_choice")
        self.assertFalse(preview.get("plan_id"))
        payload = json.dumps([inspection, preview], ensure_ascii=False)
        self.assertIn("last_row", payload)
        self.assertIn("latest_timestamp", payload)
        self.assertNotIn("other@example.invalid", payload)
        self.assertNotIn("阿甲", payload)

    def test_manual_candidate_uses_same_preview_and_rejects_extra_actions(self):
        self.write_source()
        draft = self.runner.draft(self.source.name, "按邮箱保留时间最新的报名")
        self.assertIn("报名时间", draft["prompt"])
        self.assertNotIn("other@example.invalid", draft["prompt"])
        path = self.root / "candidate.json"
        candidate = {"key": "邮箱", "keep": "latest_timestamp", "time_column": "报名时间"}
        path.write_text(json.dumps(candidate), encoding="utf-8")
        plan = self.runner.preview(self.inspect_source()["input_id"], **self.runner.read_candidate(path.name))
        result = self.runner.run(plan_id=plan["plan_id"])
        self.assertEqual(self.read_result(result), [HEADER, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])
        path.write_text(json.dumps({**candidate, "command": "untrusted"}), encoding="utf-8")
        with self.assertRaises(TaskError) as failure:
            self.runner.read_candidate(path.name)
        self.assertEqual(failure.exception.code, "invalid_candidate")

    def test_latest_matches_golden_output_and_leaves_source_unchanged(self):
        plan = self.preview("latest_timestamp")
        before = self.source.read_bytes()
        result = self.runner.run(plan_id=plan["plan_id"])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["input_rows"], 3)
        self.assertEqual(result["output_rows"], 2)
        self.assertTrue(result["checks"])
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(self.read_result(result), [HEADER, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])
        self.assertEqual(self.source.read_bytes(), before)

    def test_last_row_preserves_order_by_selected_source_position(self):
        plan = self.preview("last_row")
        result = self.runner.run(plan_id=plan["plan_id"])
        self.assertEqual(self.read_result(result), [HEADER, SAMPLE_ROWS[1], SAMPLE_ROWS[2]])

    def test_repeat_plan_returns_same_result_path(self):
        plan_id = self.preview("last_row")["plan_id"]
        result = self.runner.run(plan_id=plan_id)
        again = self.runner.run(plan_id=plan_id)
        self.assertEqual(again["output_path"], result["output_path"])
        self.assertEqual(self.read_result(again), self.read_result(result))

    def test_concurrent_replays_publish_one_verified_artifact(self):
        self.preview("latest_timestamp", save_as="attendance")
        source = self.root / "concurrent.csv"
        write_csv(source, HEADER, list(reversed(SAMPLE_ROWS)))
        command = [
            sys.executable, "-B", str(PLUGIN / "task_reuse.py"), "--workspace", str(self.root),
            "run", "attendance", "--input", source.name,
        ]
        with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8") as first:
            with subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding="utf-8") as second:
                results = []
                for process in (first, second):
                    try:
                        stdout, stderr = process.communicate(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.communicate()
                        raise
                    self.assertEqual(process.returncode, 0, f"{stdout}\n{stderr}")
                    results.append(json.loads(stdout))
        self.assertEqual(results[0]["output_path"], results[1]["output_path"])
        self.assertEqual(self.read_result(results[0]), [HEADER, SAMPLE_ROWS[1], SAMPLE_ROWS[0]])
        self.assertEqual(len(list((self.root / "task-reuse-output").glob("*.csv"))), 2)

    def test_existing_output_with_other_content_is_not_overwritten(self):
        plan_id = self.preview("last_row")["plan_id"]
        result = self.runner.run(plan_id=plan_id)
        output = Path(result["output_path"])
        output.write_bytes(b"existing local edits")
        with self.assertRaises(TaskError) as failure:
            self.runner.run(plan_id=plan_id)
        self.assertEqual(failure.exception.code, "output_exists")
        self.assertEqual(output.read_bytes(), b"existing local edits")

    def test_saved_rule_uses_new_data_after_runner_restart(self):
        self.preview("latest_timestamp", save_as="attendance")
        rows = [
            ["new@example.invalid", "2026-11-08T10:00:00+08:00", "本周甲"],
            ["new@example.invalid", "2026-11-08T12:00:00+08:00", "本周乙"],
        ]
        write_csv(self.root / "下周.csv", HEADER, rows)
        result = Runner(self.root).run(recipe_id="attendance", input_path="下周.csv")
        self.assertEqual(result["model_calls"], 0)
        self.assertEqual(self.read_result(result), [HEADER, rows[1]])

    def test_saved_replay_matches_explicit_preview_artifact(self):
        self.preview("latest_timestamp", save_as="attendance")
        next_file = self.root / "next.csv"
        write_csv(next_file, HEADER, list(reversed(SAMPLE_ROWS)))
        direct = self.runner.run(recipe_id="attendance", input_path=next_file.name)
        inspected = self.runner.inspect(next_file.name)
        plan = self.runner.preview(inspected["input_id"], recipe_id="attendance")
        explicit = self.runner.run(plan_id=plan["plan_id"])
        self.assertEqual(direct["output_path"], explicit["output_path"])
        self.assertEqual(self.read_result(direct), [HEADER, SAMPLE_ROWS[1], SAMPLE_ROWS[0]])

    def test_saved_replay_rechecks_source_before_publish(self):
        self.preview("latest_timestamp", save_as="attendance")
        next_file = self.root / "next.csv"
        write_csv(next_file, HEADER, SAMPLE_ROWS)
        original = self.runner.read_source

        def read_then_change(relative):
            data = original(relative)
            write_csv(next_file, HEADER, SAMPLE_ROWS[:2])
            return data

        before = set((self.root / "task-reuse-output").glob("*.csv"))
        with patch.object(self.runner, "read_source", side_effect=read_then_change), self.assertRaises(TaskError) as failure:
            self.runner.run(recipe_id="attendance", input_path=next_file.name)
        self.assertEqual(failure.exception.code, "input_changed")
        self.assertEqual(set((self.root / "task-reuse-output").glob("*.csv")), before)

    def test_renamed_timestamp_requires_an_explicit_rebinding(self):
        self.preview("latest_timestamp", save_as="attendance")
        renamed = ["邮箱", "提交时间", "姓名"]
        self.write_source(header=renamed)
        before = set((self.root / "task-reuse-output").glob("*.csv"))
        direct_replay = self.runner.run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(direct_replay["status"], "needs_binding")
        self.assertEqual(set((self.root / "task-reuse-output").glob("*.csv")), before)
        input_id = self.inspect_source()["input_id"]
        drift = self.runner.preview(input_id, recipe_id="attendance")
        self.assertEqual(drift["status"], "needs_binding")
        self.assertFalse(drift.get("plan_id"))
        repaired = self.runner.preview(input_id, recipe_id="attendance", replacement="提交时间")
        self.assertEqual(repaired["status"], "ready")
        result = self.runner.run(plan_id=repaired["plan_id"], save_as="attendance")
        self.assertEqual(self.read_result(result), [renamed, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])
        result = Runner(self.root).run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(self.read_result(result), [renamed, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])
        self.write_source()
        original_layout = Runner(self.root).run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(self.read_result(original_layout), [HEADER, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])

    def test_legacy_recipe_keeps_original_binding_when_repaired(self):
        self.preview("latest_timestamp", save_as="attendance")
        saved_path = self.root / ".task-reuse" / "recipes" / "attendance.json"
        legacy = json.loads(saved_path.read_text(encoding="utf-8"))
        del legacy["layouts"]
        saved_path.write_text(json.dumps(legacy), encoding="utf-8")

        renamed = ["邮箱", "提交时间", "姓名"]
        write_csv(self.root / "renamed.csv", renamed, SAMPLE_ROWS)
        result = self.runner.process("renamed.csv", recipe_id="attendance", replacement="提交时间", save_as="attendance")
        self.assertEqual(result["recipe_revision"], 2)
        self.assertEqual(self.read_result(result), [renamed, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])

        original = Runner(self.root).run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(self.read_result(original), [HEADER, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])

    def test_both_known_timestamp_headers_require_one_choice_on_new_layout(self):
        self.preview("latest_timestamp", save_as="attendance")
        self.write_source(header=["邮箱", "提交时间", "姓名"])
        new_layout = self.runner.preview(self.inspect_source()["input_id"], recipe_id="attendance", replacement="提交时间")
        self.runner.run(plan_id=new_layout["plan_id"], save_as="attendance")

        header = ["邮箱", "报名时间", "提交时间", "姓名"]
        rows = [
            ["same@example.invalid", "2026-11-01T12:00:00Z", "2026-11-01T10:00:00Z", "原字段下最新"],
            ["same@example.invalid", "2026-11-01T10:00:00Z", "2026-11-01T12:00:00Z", "新字段下最新"],
        ]
        self.write_source(rows=rows, header=header)
        ambiguous = self.runner.run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(ambiguous["status"], "needs_binding")
        self.assertEqual(set(ambiguous["alternatives"]["time_column"]), {"报名时间", "提交时间"})
        chosen = self.runner.preview(self.inspect_source()["input_id"], recipe_id="attendance", replacement="提交时间")
        applied = self.runner.run(plan_id=chosen["plan_id"], save_as="attendance")
        self.assertEqual(self.read_result(applied), [header, rows[1]])
        reordered = [2, 3, 0, 1]
        reordered_header = [header[index] for index in reordered]
        reordered_rows = [[row[index] for index in reordered] for row in rows]
        self.write_source(rows=reordered_rows, header=reordered_header)
        replay = Runner(self.root).run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(self.read_result(replay), [reordered_header, reordered_rows[1]])

    def test_input_modified_between_preview_and_run_is_rejected(self):
        plan_id = self.preview("last_row")["plan_id"]
        self.write_source(rows=SAMPLE_ROWS[:2])
        with self.assertRaises(TaskError):
            self.runner.run(plan_id=plan_id)

    def test_input_modified_between_inspection_and_preview_is_rejected(self):
        self.write_source()
        input_id = self.inspect_source()["input_id"]
        self.write_source(rows=SAMPLE_ROWS[:2])
        with self.assertRaises(TaskError):
            self.runner.preview(input_id, key="邮箱", keep="last_row")

    def test_unrelated_rule_cannot_replace_a_saved_rule(self):
        self.preview("latest_timestamp", save_as="attendance")
        plan_id = self.preview("last_row")["plan_id"]
        with self.assertRaises(TaskError):
            self.runner.run(plan_id=plan_id, save_as="attendance")
        result = Runner(self.root).run(recipe_id="attendance", input_path=self.source.name)
        self.assertEqual(self.read_result(result), [HEADER, SAMPLE_ROWS[0], SAMPLE_ROWS[1]])

    def test_duplicate_headers_and_incorrect_row_width_are_rejected(self):
        for name, header, rows in (
            ("duplicate headers", ["邮箱", "邮箱", "姓名"], SAMPLE_ROWS),
            ("missing field", HEADER, [["one@example.invalid", "2026-11-01T10:00:00+08:00"]]),
            ("extra field", HEADER, [SAMPLE_ROWS[0] + ["extra"]]),
        ):
            with self.subTest(name=name):
                self.write_source(rows=rows, header=header)
                with self.assertRaises(TaskError):
                    self.inspect_source()

    def test_empty_key_invalid_timestamp_and_conflicting_latest_tie_are_rejected(self):
        for name, rows in (
            ("empty key", [[" ", SAMPLE_ROWS[0][1], "empty"]]),
            ("invalid timestamp", [[SAMPLE_ROWS[0][0], "not a timestamp", "invalid"]]),
            ("conflicting tie", [SAMPLE_ROWS[0], SAMPLE_ROWS[0][0:2] + ["different"]]),
        ):
            with self.subTest(name=name):
                self.write_source(rows=rows)
                input_id = self.inspect_source()["input_id"]
                with self.assertRaises(TaskError):
                    plan = self.runner.preview(
                        input_id, key="邮箱", keep="latest_timestamp", time_column="报名时间"
                    )
                    self.runner.run(plan_id=plan["plan_id"])

    def test_latest_orders_by_instant_across_offset_and_calendar_boundary(self):
        rows = [
            ["same@example.invalid", "2026-11-02T00:30:00+08:00", "本地日期较晚"],
            ["same@example.invalid", "2026-11-01T17:00:00Z", "实际时间较晚"],
        ]
        self.write_source(rows=rows)
        plan = self.runner.preview(self.inspect_source()["input_id"], key="邮箱", keep="latest_timestamp", time_column="报名时间")
        result = self.runner.run(plan_id=plan["plan_id"])
        self.assertEqual(self.read_result(result), [HEADER, rows[1]])

    def test_only_distinct_ties_at_the_latest_instant_are_rejected(self):
        early = ["same@example.invalid", "2026-11-02T00:30:00+08:00", "较旧记录 A"]
        tied_early = ["same@example.invalid", "2026-11-01T16:30:00Z", "较旧记录 B"]
        latest = ["same@example.invalid", "2026-11-01T17:00:00Z", "最新记录"]
        self.write_source(rows=[early, tied_early, latest, latest])
        plan = self.runner.preview(self.inspect_source()["input_id"], key="邮箱", keep="latest_timestamp", time_column="报名时间")
        self.assertEqual(self.read_result(self.runner.run(plan_id=plan["plan_id"])), [HEADER, latest])
        self.write_source(rows=[latest, ["same@example.invalid", "2026-11-02T01:00:00+08:00", "同一时刻内容不同"]])
        with self.assertRaises(TaskError) as failure:
            self.runner.preview(self.inspect_source()["input_id"], key="邮箱", keep="latest_timestamp", time_column="报名时间")
        self.assertEqual(failure.exception.code, "timestamp_tie")

    def test_mixed_timezone_presence_is_rejected(self):
        self.write_source(rows=[
            ["same@example.invalid", "2026-11-01T11:00:00", "未指定时区"],
            ["same@example.invalid", "2026-11-01T12:00:00Z", "指定时区"],
        ])
        with self.assertRaises(TaskError) as failure:
            self.runner.preview(self.inspect_source()["input_id"], key="邮箱", keep="latest_timestamp", time_column="报名时间")
        self.assertEqual(failure.exception.code, "mixed_timezones")

    def test_outside_and_absolute_paths_are_rejected(self):
        outside = self.root.parent / "outside.csv"
        write_csv(outside, HEADER, SAMPLE_ROWS)
        self.write_source()
        for path in ("../outside.csv", str(outside), str(self.source)):
            with self.subTest(path=path), self.assertRaises(TaskError):
                self.runner.inspect(path)

    def test_symlink_to_file_outside_workspace_is_rejected(self):
        outside = self.root.parent / "outside.csv"
        write_csv(outside, HEADER, SAMPLE_ROWS)
        try:
            self.source.symlink_to(outside)
        except (NotImplementedError, OSError) as exc:
            self.skipTest(f"Creating a symlink is unavailable: {exc}")
        with self.assertRaises(TaskError):
            self.inspect_source()


if __name__ == "__main__":
    unittest.main()
