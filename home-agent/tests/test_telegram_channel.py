"""Telegram inbound messages as the renderer receives them from the poll queue,
and the outbound sends the Answer flow relies on.

Stdlib only; python-telegram-bot is not needed, since a message is read through
its attributes and stood in for by a namespace, and the bot is a recording fake.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.telegram import (
    TelegramChannel,
    answer_callback_item,
    inbound_text_item,
)


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

    def test_an_answer_tap_names_the_message_the_button_is_under(self) -> None:
        tapped = SimpleNamespace(chat_id=4242, message_id=1234)
        item = answer_callback_item(SimpleNamespace(data="answer", message=tapped))
        self.assertEqual(
            item, {"chat_id": "4242", "callback": "answer", "reply_to": "1234"}
        )


class FakeForceReply:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


class TelegramAnswerPromptTest(unittest.TestCase):
    def setUp(self) -> None:
        fake_telegram = types.ModuleType("telegram")
        fake_telegram.ForceReply = FakeForceReply  # type: ignore[attr-defined]
        self._saved = sys.modules.get("telegram")
        sys.modules["telegram"] = fake_telegram
        self.sent: list[dict] = []

        async def send_message(**kwargs):
            self.sent.append(kwargs)
            return SimpleNamespace(message_id=901)

        self._dir = tempfile.TemporaryDirectory()
        self.channel = TelegramChannel(Path(self._dir.name))
        self.channel._app_instance = SimpleNamespace(
            bot=SimpleNamespace(send_message=send_message)
        )
        self.channel._bot_chat_id = "4242"
        self.channel._run_coro = lambda coro, timeout=10.0: asyncio.run(coro)  # type: ignore[method-assign]

    def tearDown(self) -> None:
        if self._saved is None:
            sys.modules.pop("telegram", None)
        else:
            sys.modules["telegram"] = self._saved
        self._dir.cleanup()

    def test_an_answer_prompt_opens_reply_mode_with_a_placeholder(self) -> None:
        result = self.channel.send_reply(
            {
                "text": "Your message to “Asteroids clone”:",
                "force_reply": True,
                "input_field_placeholder": "Message to “Asteroids clone”",
            }
        )
        self.assertEqual(result, {"status": "ok", "message_id": 901})
        markup = self.sent[0]["reply_markup"]
        self.assertIsInstance(markup, FakeForceReply)
        self.assertEqual(
            markup.kwargs,
            {"input_field_placeholder": "Message to “Asteroids clone”"},
        )

    def test_a_plain_reply_has_no_reply_markup(self) -> None:
        self.channel.send_reply({"text": "hello"})
        self.assertIsNone(self.sent[0]["reply_markup"])


if __name__ == "__main__":
    unittest.main()
