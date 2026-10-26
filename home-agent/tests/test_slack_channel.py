"""Slack inbound DMs as the renderer receives them from the poll queue.

Stdlib only; slack-bolt is not needed, since an inbound DM is a plain event dict.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.slack import inbound_item

USER = "U123"
IM = "D456"


def event(text: str, ts: str, thread_ts: str | None = None) -> dict:
    return {
        "text": text,
        "user": USER,
        "channel": IM,
        "ts": ts,
        **({"thread_ts": thread_ts} if thread_ts else {}),
    }


class SlackInboundTest(unittest.TestCase):
    def test_a_thread_reply_names_the_thread_it_answers(self) -> None:
        item = inbound_item(
            event("try a smaller level", ts="1700.0002", thread_ts="1700.0001"),
            "try a smaller level",
        )
        self.assertEqual(
            item,
            {
                "text": "try a smaller level",
                "chat_id": USER,
                "channel": IM,
                "ts": "1700.0002",
                "reply_to": "1700.0001",
                "reply_target": "1700.0001",
            },
        )

    def test_a_top_level_message_answers_nothing_and_starts_its_own_thread(
        self,
    ) -> None:
        item = inbound_item(event("hello", ts="1700.0003"), "hello")
        self.assertEqual(
            item,
            {
                "text": "hello",
                "chat_id": USER,
                "channel": IM,
                "ts": "1700.0003",
                "reply_target": "1700.0003",
            },
        )

    def test_a_thread_root_echo_is_not_a_reply_to_itself(self) -> None:
        item = inbound_item(
            event("hello", ts="1700.0003", thread_ts="1700.0003"), "hello"
        )
        self.assertNotIn("reply_to", item)
        self.assertEqual(item["reply_target"], "1700.0003")

    def test_a_voice_reply_in_a_thread_keeps_its_audio(self) -> None:
        voice = [{"mime": "audio/webm", "data_base64": "T2dn"}]
        item = inbound_item(
            event("", ts="1700.0004", thread_ts="1700.0001"), "", audio=voice
        )
        self.assertEqual(item["reply_to"], "1700.0001")
        self.assertEqual(item["audio"], voice)


if __name__ == "__main__":
    unittest.main()
