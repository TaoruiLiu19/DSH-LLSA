import csv
import json
import subprocess
import sys

from test_mcp import McpSession, PLUGIN


PIPELINE = "run_csv_pipeline"
HEADER = ["id", "state", "region"]
FILTER_VALUE = "private-filter-value"
STEPS = [
    {"op": "filter_eq", "column": "state", "value": FILTER_VALUE},
    {"op": "dedupe", "key": "id", "keep": "last_row"},
    {"op": "group_count", "column": "region"},
]


class WorkflowReuseTests(McpSession):
    server_args = ("--dsh-workflows",)

    def assert_output(self, receipt, expected):
        self.assertEqual(receipt["status"], "completed")
        with (self.workspace / receipt["output_path"]).open(encoding="utf-8-sig", newline="") as source:
            self.assertEqual(list(csv.reader(source)), expected)

    def assert_failure(self, code, **arguments):
        result = self.call(PIPELINE, **arguments)
        self.assertTrue(result.get("isError"), result)
        self.assertEqual(result["structuredContent"]["code"], code)

    def outputs(self):
        return set((self.workspace / "task-reuse-output").glob("*.csv"))

    def test_preview_approve_and_replay_on_different_data(self):
        self.write_sample("this-week.csv", HEADER, [
            ["1", FILTER_VALUE, "west"], ["1", FILTER_VALUE, "north"],
            ["2", "cancelled", "south"], ["3", FILTER_VALUE, "north"],
        ])
        preview = self.result(PIPELINE, path="this-week.csv", steps=STEPS, preview=True)
        self.assertEqual(preview["status"], "ready")
        self.assertTrue(preview["plan_id"])
        self.assertNotIn("output_path", preview)
        self.assertEqual(self.outputs(), set())

        applied = self.result(PIPELINE, plan_id=preview["plan_id"], save_as="active-regions")
        self.assertEqual(applied["workflow"], "active-regions")
        self.assert_output(applied, [["region", "count"], ["north", "2"]])

        self.write_sample("next-week.csv", HEADER, [
            ["5", FILTER_VALUE, "east"], ["6", FILTER_VALUE, "east"],
            ["6", "cancelled", "south"], ["7", FILTER_VALUE, "south"],
        ])
        existing = self.outputs()
        replay_preview = self.result(PIPELINE, path="next-week.csv", workflow="active-regions", preview=True)
        self.assertEqual(replay_preview["status"], "ready")
        self.assertTrue(replay_preview["plan_id"])
        self.assertNotIn("output_path", replay_preview)
        self.assertEqual(self.outputs(), existing)
        expected = [["region", "count"], ["east", "2"], ["south", "1"]]
        approved_replay = self.result(PIPELINE, plan_id=replay_preview["plan_id"])
        self.assert_output(approved_replay, expected)
        replay = self.result(PIPELINE, path="next-week.csv", workflow="active-regions")
        self.assertEqual(replay["workflow"], "active-regions")
        self.assertEqual(replay["output_path"], approved_replay["output_path"])
        self.assert_output(replay, expected)

    def test_approval_rejects_changed_input_without_output_or_saved_workflow(self):
        self.write_sample("changed.csv", HEADER, [["1", FILTER_VALUE, "east"]])
        preview = self.result(PIPELINE, path="changed.csv", steps=STEPS, preview=True)
        self.write_sample("changed.csv", HEADER, [["1", FILTER_VALUE, "west"]])

        self.assert_failure("input_changed", plan_id=preview["plan_id"], save_as="stale")
        self.assertEqual(self.outputs(), set())
        self.assertEqual(self.result(PIPELINE, list_workflows=True), {"status": "listed", "workflows": []})

    def test_preview_cannot_save_and_approval_cannot_override_the_plan(self):
        self.write_sample("workflow.csv", HEADER, [["1", FILTER_VALUE, "east"]])
        self.assert_failure("invalid_preview", path="workflow.csv", steps=STEPS, preview=True, save_as="unexpected")
        preview = self.result(PIPELINE, path="workflow.csv", steps=STEPS, preview=True)
        self.assert_failure("invalid_workflow_request", plan_id=preview["plan_id"], path="workflow.csv")
        self.assert_failure("invalid_workflow_request", plan_id=preview["plan_id"], steps=STEPS)
        self.assertEqual(self.outputs(), set())
        self.assertEqual(self.result(PIPELINE, list_workflows=True)["workflows"], [])

    def test_different_recipe_cannot_replace_existing_name_or_publish_output(self):
        self.write_sample("workflow.csv", HEADER, [["1", FILTER_VALUE, "east"], ["2", "cancelled", "west"]])
        original = self.result(PIPELINE, path="workflow.csv", steps=STEPS, save_as="active-regions")
        self.assertEqual(original["workflow"], "active-regions")
        self.assert_output(original, [["region", "count"], ["east", "1"]])
        existing = self.outputs()

        alternate = [{"op": "group_count", "column": "region"}]
        self.assert_failure("workflow_conflict", path="workflow.csv", steps=alternate, save_as="active-regions")
        preview = self.result(PIPELINE, path="workflow.csv", steps=alternate, preview=True)
        self.assert_failure("workflow_conflict", plan_id=preview["plan_id"], save_as="active-regions")
        self.assertEqual(self.outputs(), existing)
        replay = self.result(PIPELINE, path="workflow.csv", workflow="active-regions")
        self.assertEqual(replay["output_path"], original["output_path"])
        self.assert_output(replay, [["region", "count"], ["east", "1"]])

    def test_blocked_workflow_storage_does_not_publish_csv(self):
        self.write_sample("workflow.csv", HEADER, [["1", FILTER_VALUE, "east"]])
        preview = self.result(PIPELINE, path="workflow.csv", steps=STEPS, preview=True)
        blocked = self.workspace / ".task-reuse" / "workflows"
        blocked.write_text("preserve this file", encoding="utf-8")

        self.assert_failure("workflow_unavailable", plan_id=preview["plan_id"], save_as="active-regions")
        self.assertEqual(self.outputs(), set())
        self.assertEqual(blocked.read_text(encoding="utf-8"), "preserve this file")

    def test_replay_reports_schema_drift_without_row_values(self):
        self.write_sample("original.csv", HEADER, [["1", FILTER_VALUE, "east"]])
        self.result(PIPELINE, path="original.csv", steps=STEPS, save_as="active-regions")
        existing = self.outputs()
        drifted_header = ["id", "state", "territory"]
        marker = "private-cell-value"
        self.write_sample("drifted.csv", drifted_header, [["1", FILTER_VALUE, marker]])

        failure = self.call(PIPELINE, path="drifted.csv", workflow="active-regions")
        self.assertTrue(failure.get("isError"), failure)
        detail = failure["structuredContent"]
        self.assertEqual(detail["code"], "unknown_column")
        self.assertEqual(detail["column"], "region")
        self.assertEqual(detail["columns"], drifted_header)
        self.assertEqual(detail["step"], 3)
        for private in (marker, FILTER_VALUE):
            self.assertNotIn(private, json.dumps(failure))
        self.assertEqual(self.outputs(), existing)

    def test_discovery_returns_names_and_operation_types_without_data(self):
        marker = "private-cell-content"
        self.write_sample("private.csv", HEADER, [["1", FILTER_VALUE, marker]])
        self.result(PIPELINE, path="private.csv", steps=STEPS, save_as="active-regions")

        response = self.call(PIPELINE, list_workflows=True)
        self.assertFalse(response.get("isError"), response)
        self.assertEqual(response["structuredContent"], {
            "status": "listed",
            "workflows": [{"name": "active-regions", "operations": ["filter_eq", "dedupe", "group_count"]}],
        })
        for private in (FILTER_VALUE, marker, "private.csv"):
            self.assertNotIn(private, json.dumps(response))

    def test_cli_plan_and_apply_are_reusable_over_mcp(self):
        self.write_sample("workflow.csv", HEADER, [["1", FILTER_VALUE, "west"]])
        (self.workspace / "workflow-steps.json").write_text(json.dumps(STEPS), encoding="utf-8")

        def cli(*arguments):
            process = subprocess.run(
                [sys.executable, "-B", str(PLUGIN / "task_reuse.py"), "--workspace", str(self.workspace),
                 "workflow", *arguments],
                cwd=self.workspace, capture_output=True, encoding="utf-8", timeout=15,
            )
            self.assertEqual(process.returncode, 0, process.stderr or process.stdout)
            return json.loads(process.stdout)

        preview = cli("plan", "workflow.csv", "--steps-file", "workflow-steps.json")
        self.assertEqual(preview["status"], "ready")
        self.assertEqual(self.outputs(), set())
        applied = cli("apply", preview["plan_id"], "--save-as", "from-cli")
        self.assertEqual(applied["workflow"], "from-cli")
        self.assert_output(applied, [["region", "count"], ["west", "1"]])
        self.assertEqual(cli("list"), self.result(PIPELINE, list_workflows=True))

        self.write_sample("another.csv", HEADER, [["2", FILTER_VALUE, "east"]])
        existing = self.outputs()
        self.assertEqual(cli("run", "from-cli", "--input", "another.csv", "--preview")["status"], "ready")
        self.assertEqual(self.outputs(), existing)
        offline = cli("run", "from-cli", "--input", "another.csv")
        self.assertEqual(offline["model_calls"], 0)
        self.assert_output(offline, [["region", "count"], ["east", "1"]])
        replay = self.result(PIPELINE, path="another.csv", workflow="from-cli")
        self.assertEqual(replay["output_ref"], offline["output_ref"])
