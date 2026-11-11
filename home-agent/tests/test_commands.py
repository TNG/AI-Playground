"""The slash commands and buttons Telegram and Slack forward to the router."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.commands import (
    CHANNEL_COMMANDS,
    COMMAND_CALLBACKS,
    command_for_callback,
)


class CommandsTest(unittest.TestCase):
    def test_agents_forwards_the_name_typed_after_it(self) -> None:
        agents = next(cmd for cmd in CHANNEL_COMMANDS if cmd.name == "agents")
        self.assertEqual(
            agents.build_full_text(["Daily", "digest"]), "/agents Daily digest"
        )
        self.assertEqual(agents.build_full_text([]), "/agents")

    def test_a_tapped_session_or_agent_becomes_its_command(self) -> None:
        self.assertEqual(command_for_callback("loadConv:session-1"), "/load session-1")
        self.assertEqual(
            command_for_callback("runAgent:agent-digest"), "/agents agent-digest"
        )

    def test_other_buttons_are_not_commands(self) -> None:
        self.assertIsNone(command_for_callback("confirm:q1:yes"))

    def test_every_button_prefix_names_a_registered_command(self) -> None:
        names = {cmd.slash for cmd in CHANNEL_COMMANDS}
        for command in COMMAND_CALLBACKS.values():
            self.assertIn(command, names)


if __name__ == "__main__":
    unittest.main()
