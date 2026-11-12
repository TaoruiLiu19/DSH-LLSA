import csv
import json
from pathlib import Path

from test_mcp import McpSession


EXAMPLES = {
    "活动时间与课程冲突": "时间",
    "错过末班车，无法抵达": "交通",
    "临时身体不适需要休息": "身体",
    "改为参加下一期活动": "其他",
}
LABELS = list(EXAMPLES.values())


class CsvWorkflowMcpTests(McpSession):
    server_args = ("--dsh-workflows",)

    def prepare_review(self, repetitions=250):
        rows = [[f"private-{index:04d}", text] for index, text in enumerate(list(EXAMPLES) * repetitions)]
        self.write_sample("feedback.csv", ["id", "reason"], rows)
        pending = self.result("review_csv", path="feedback.csv", column="reason", labels=LABELS)
        return rows, pending

    def apply_review(self, pending, assignments):
        return self.result("review_csv", review_id=pending["review_id"], assignments=assignments)

    def test_exact_repeated_texts_reduce_review_and_expand_to_every_row(self):
        listed = self.client.request("tools/list")["result"]["tools"]
        self.assertEqual({tool["name"] for tool in listed}, {"run_csv_pipeline", "review_csv"})
        rows, pending = self.prepare_review()
        self.assertEqual(pending["status"], "needs_labels")
        self.assertEqual(pending["input_rows"], 1000)
        self.assertEqual(pending["distinct_values"], 4)
        self.assertEqual([item["rows"] for item in pending["candidates"]], [250] * 4)
        self.assertLess(pending["grouped_review_estimate_bytes"], pending["ungrouped_values_bytes"] // 10)
        self.assertNotIn("private-", json.dumps(pending))
        assignments = [{"id": item["id"], "label": EXAMPLES[item["text"]]} for item in pending["candidates"]]
        result = self.apply_review(pending, assignments)
        self.assertEqual(result["output_rows"], 1000)
        with Path(result["output_path"]).open(encoding="utf-8-sig", newline="") as source:
            output = list(csv.reader(source))
        self.assertEqual(output, [["id", "reason", "review_label"], *[[*row, EXAMPLES[row[1]]] for row in rows]])
        self.assertEqual(result["output_path"], self.apply_review(pending, assignments[::-1])["output_path"])

    def test_missing_duplicate_or_unapproved_labels_leave_no_output(self):
        _, pending = self.prepare_review(20)
        assignments = [{"id": item["id"], "label": EXAMPLES[item["text"]]} for item in pending["candidates"]]
        for bad in (assignments[:-1], [assignments[0], *assignments[:-1]], [{"id": 1, "label": "未知"}, *assignments[1:]]):
            with self.subTest(bad=bad):
                failure = self.call("review_csv", review_id=pending["review_id"], assignments=bad)
                self.assertTrue(failure["isError"])
                self.assertEqual(failure["structuredContent"]["code"], "invalid_assignments")
        self.assertFalse((self.workspace / "task-reuse-output").exists())

    def test_review_refuses_changed_input(self):
        rows, pending = self.prepare_review(20)
        assignments = [{"id": item["id"], "label": EXAMPLES[item["text"]]} for item in pending["candidates"]]
        self.write_sample("feedback.csv", ["id", "reason"], rows[:-1])
        failure = self.call("review_csv", review_id=pending["review_id"], assignments=assignments)
        self.assertTrue(failure["isError"])
        self.assertEqual(failure["structuredContent"]["code"], "input_changed")
        self.assertFalse((self.workspace / "task-reuse-output").exists())

    def test_review_skips_when_grouping_is_unprofitable(self):
        for count, reason in ((12, "insufficient_byte_savings"), (65, "too_many_distinct_values")):
            with self.subTest(count=count):
                self.write_sample("distinct.csv", ["text"], [[f"unique-{i}"] for i in range(count)])
                skipped = self.result("review_csv", path="distinct.csv", column="text", labels=LABELS)
                self.assertEqual(skipped["status"], "not_applicable")
                self.assertEqual(skipped["reason"], reason)
                self.assertNotIn("candidates", skipped)
                self.assertNotIn("review_id", skipped)

        self.write_sample("short.csv", ["text"], [["a"]] * 40)
        skipped = self.result("review_csv", path="short.csv", column="text", labels=["x"])
        self.assertEqual(skipped["status"], "not_applicable")
        self.assertNotIn("candidates", skipped)

    def test_pipeline_reports_failing_step_over_mcp(self):
        self.write_sample("activity.csv", ["state", "region"], [["active", "north"], ["cancelled", "south"]])
        info = self.result("run_csv_pipeline", path="activity.csv")
        self.assertEqual(info, {"status": "inspected", "columns": ["state", "region"], "row_count": 2})
        failure = self.call("run_csv_pipeline", path="activity.csv", steps=[
            {"op": "filter_eq", "column": "state", "value": "active"},
            {"op": "group_count", "column": "missing"},
        ])
        self.assertTrue(failure["isError"])
        self.assertEqual(failure["structuredContent"]["step"], 2)
        self.assertFalse((self.workspace / "task-reuse-output").exists())
