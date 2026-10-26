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

from channels.telegram import inbound_item, inbound_text_item


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

    def test_a_voice_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        voice = [{"mime": "audio/ogg", "data_base64": "T2dn"}]
        item = inbound_item(message("", reply_to_id=1234), "", audio=voice)
        self.assertEqual(
            item, {"text": "", "chat_id": "4242", "audio": voice, "reply_to": "1234"}
        )

    def test_a_photo_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        photo = [{"mime": "image/jpeg", "data_base64": "/9j/"}]
        item = inbound_item(message("", reply_to_id=1234), "[image]", images=photo)
        self.assertEqual(
            item,
            {"text": "[image]", "chat_id": "4242", "images": photo, "reply_to": "1234"},
        )

    def test_a_document_without_a_reply_carries_no_reply_target(self) -> None:
        doc = [{"filename": "level.txt", "mime": "text/plain", "data_base64": "YQ=="}]
        item = inbound_item(message(""), "levels", documents=doc)
        self.assertEqual(item, {"text": "levels", "chat_id": "4242", "documents": doc})


if __name__ == "__main__":
    unittest.main()
