"""Create the local DeepSeek Harness profile overlay without editing user settings."""

import sys
from pathlib import Path


def profile_patch(workspace, workflows=False):
    directory = Path(__file__).resolve().parent
    return [{
        "insert": [{
            "id": "mcp-task-reuse",
            "name": "@deepseek-ai/dsh-mcp-client",
            "config": {
                "serverName": "task_reuse",
                "transport": "stdio",
                "command": str(Path(sys.executable).resolve()),
                "args": ["-B", str(directory / "mcp_server.py"), "--dsh-workflows" if workflows else "--dsh"],
                "cwd": str(directory),
                "env": {"TASK_REUSE_WORKSPACE": str(workspace)},
            },
        }],
    }]
