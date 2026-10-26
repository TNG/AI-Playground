"""Telegram inbound messages as the renderer receives them from the poll queue.

Stdlib only; python-telegram-bot is not needed, since a message is read through
its attributes and stood in for by a namespace.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.telegram import inbound_text_item


def message(text: str, reply_to_id: int | None = None) -> SimpleNamespace:
    reply = SimpleNamespace(message_id=reply_to_id) if reply_to_id is not None else None
    return SimpleNamespace(
        text=text, chat_id=4242, message_id=7, reply_to_message=reply
    )


class TelegramInboundTest(unittest.TestCase):
    def test_a_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        item = inbound_text_item(message("try a smaller level", reply_to_id=1234))
        self.assertEqual(
            item, {"text": "try a smaller level", "chat_id": "4242", "reply_to": "1234"}
        )

    def test_a_plain_message_carries_no_reply_target(self) -> None:
        item = inbound_text_item(message("hello"))
        self.assertEqual(item, {"text": "hello", "chat_id": "4242"})


if __name__ == "__main__":
    unittest.main()
