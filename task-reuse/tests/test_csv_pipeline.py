import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


PLUGIN = Path(__file__).resolve().parents[1] / "plugins" / "task-reuse"
sys.path.insert(0, str(PLUGIN))

from csv_pipeline import execute_pipeline
from task_reuse import Runner, TaskError


HEADERS = ["邮箱", "状态", "时间", "分组"]
ROWS = [
    ["a-private@example.invalid", "已付款", "2026-11-12T09:00:00+08:00", "北区"],
    ["A-PRIVATE@example.invalid", "已取消", "2026-11-12T10:00:00+08:00", "北区"],
    ["b@example.invalid", "已付款", "2026-11-12T11:00:00+08:00", "南区"],
    ["b@example.invalid", "已付款", "2026-11-12T12:00:00+08:00", "北区"],
    ["c@example.invalid", "已取消", "2026-11-12T08:00:00+08:00", "东区"],
    ["d@example.invalid", "已付款", "2026-11-12T12:00:00+08:00", "南区"],
    ["d@example.invalid", "已付款", "2026-11-12T11:00:00+08:00", "北区"],
]
FILTER_PAID = {"op": "filter_eq", "column": "状态", "value": "已付款"}
KEEP_LATEST = {"op": "dedupe", "key": "邮箱", "keep": "latest_timestamp", "time_column": "时间"}
GROUP_BY_REGION = {"op": "group_count", "column": "分组"}


class CsvPipelineTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="pipeline-test-", dir=Path(__file__).parent)
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name) / "首次任务 工作区"
        self.root.mkdir()
        self.runner = Runner(self.root)
        self.source = self.write_csv("报名表.csv", HEADERS, ROWS)

    def write_csv(self, name, headers, rows):
        path = self.root / name
        with path.open("w", encoding="utf-8-sig", newline="") as stream:
            writer = csv.writer(stream)
            writer.writerow(headers)
            writer.writerows(rows)
        return path

    def read_csv(self, receipt):
        path = self.root / receipt["output_path"]
        with path.open(encoding="utf-8-sig", newline="") as stream:
            return list(csv.reader(stream))

    def artifacts(self):
        return set(self.root.rglob("*.csv")) - {self.source}

    def test_first_time_workflow_filters_then_deduplicates_and_counts(self):
        original = self.source.read_bytes()
        result = execute_pipeline(self.runner, self.source.name, [FILTER_PAID, KEEP_LATEST, GROUP_BY_REGION])
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["input_rows"], 7)
        self.assertEqual(result["output_rows"], 2)
        self.assertEqual(result["model_calls"], 0)
        self.assertTrue(result["checks"])
        self.assertEqual(
            [(step["op"], step["input_rows"], step["output_rows"]) for step in result["steps"]],
            [("filter_eq", 7, 5), ("dedupe", 5, 3), ("group_count", 3, 2)],
        )
        self.assertEqual(self.read_csv(result), [["分组", "count"], ["北区", "2"], ["南区", "1"]])
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(len(self.artifacts()), 1)

    def test_deduplicate_then_filter_applies_different_business_rule(self):
        result = execute_pipeline(self.runner, self.source.name, [KEEP_LATEST, FILTER_PAID, GROUP_BY_REGION])
        self.assertEqual(self.read_csv(result), [["分组", "count"], ["北区", "1"], ["南区", "1"]])
        self.assertEqual(
            [(step["input_rows"], step["output_rows"]) for step in result["steps"]],
            [(7, 4), (4, 2), (2, 2)],
        )

    def test_different_file_and_operations_work_without_a_saved_recipe(self):
        source = self.write_csv("工单.csv", ["工单", "状态", "处理组"], [
            ["001", "打开", "A"],
            ["002", "关闭", "B"],
            ["001", "打开", "B"],
            ["001", "关闭", "C"],
            ["003", "打开", "A"],
        ])
        plan = [
            {"op": "filter_eq", "column": "状态", "value": "打开"},
            {"op": "dedupe", "key": "工单", "keep": "last_row"},
        ]
        result = execute_pipeline(self.runner, source.name, plan)
        self.assertEqual(self.read_csv(result), [["工单", "状态", "处理组"], ["001", "打开", "B"], ["003", "打开", "A"]])

    def test_preview_and_repeated_run_keep_receipt_compact_and_idempotent(self):
        plan = [FILTER_PAID, KEEP_LATEST, GROUP_BY_REGION]
        preview = execute_pipeline(self.runner, self.source.name, plan, preview=True)
        self.assertEqual(preview["status"], "ready")
        self.assertEqual(preview["output_rows"], 2)
        self.assertNotIn("output_path", preview)
        self.assertFalse(self.artifacts())

        first = execute_pipeline(self.runner, self.source.name, plan)
        repeated = execute_pipeline(Runner(self.root), self.source.name, plan)
        self.assertEqual(first["output_path"], repeated["output_path"])
        self.assertEqual(len(self.artifacts()), 1)
        serialized = json.dumps([preview, first], ensure_ascii=False)
        self.assertNotIn("a-private@example.invalid", serialized)
        self.assertNotIn("2026-11-12T09:00:00", serialized)

    def test_missing_column_at_later_step_reports_its_position_without_writing(self):
        original = self.source.read_bytes()
        plan = [FILTER_PAID, {"op": "group_count", "column": "未知列"}]
        with self.assertRaises(TaskError) as failure:
            execute_pipeline(self.runner, self.source.name, plan)
        self.assertEqual(failure.exception.step, 2)
        self.assertFalse(self.artifacts())
        self.assertEqual(self.source.read_bytes(), original)

    def test_plan_validation_rejects_invalid_schema_and_unavailable_operations(self):
        cases = {
            "empty": [],
            "unknown operation": [{"op": "exec"}],
            "extra field": [{**FILTER_PAID, "output_path": "write.csv"}],
            "non-string filter": [{**FILTER_PAID, "value": 1}],
            "missing timestamp column": [{"op": "dedupe", "key": "邮箱", "keep": "latest_timestamp"}],
            "non-terminal group": [GROUP_BY_REGION, FILTER_PAID],
            "too many steps": [FILTER_PAID] * 9,
        }
        for label, plan in cases.items():
            with self.subTest(label=label), self.assertRaises(TaskError):
                execute_pipeline(self.runner, self.source.name, plan)
        self.assertFalse(self.artifacts())

    def test_empty_grouped_result_preserves_output_schema(self):
        plan = [{**FILTER_PAID, "value": "不存在的状态"}, KEEP_LATEST, GROUP_BY_REGION]
        result = execute_pipeline(self.runner, self.source.name, plan)
        self.assertEqual(result["output_rows"], 0)
        self.assertEqual(self.read_csv(result), [["分组", "count"]])

    def test_source_change_after_snapshot_stops_publication(self):
        source_read = self.runner.read_source

        def change_after_read(relative):
            data = source_read(relative)
            self.write_csv(self.source.name, HEADERS, ROWS[:2])
            return data

        with patch.object(self.runner, "read_source", side_effect=change_after_read), self.assertRaises(TaskError) as failure:
            execute_pipeline(self.runner, self.source.name, [FILTER_PAID, KEEP_LATEST, GROUP_BY_REGION])
        self.assertEqual(failure.exception.code, "input_changed")
        self.assertFalse(self.artifacts())


if __name__ == "__main__":
    unittest.main()
