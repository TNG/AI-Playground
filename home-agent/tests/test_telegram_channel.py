"""Telegram inbound messages as the renderer receives them from the poll queue.

Stdlib only; python-telegram-bot is not needed, since a message is read through
its attributes and stood in for by a namespace.
"""

from __future__ import annotations

import asyncio
import base64
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels.telegram import TelegramChannel, inbound_text_item


def message(text: str, reply_to_id: int | None = None) -> SimpleNamespace:
    reply = SimpleNamespace(message_id=reply_to_id) if reply_to_id is not None else None
    return SimpleNamespace(
        text=text, chat_id=4242, message_id=7, reply_to_message=reply
    )


class TelegramInboundTest(unittest.TestCase):
    def test_a_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        item = inbound_text_item(message("try a smaller level", reply_to_id=1234))
        self.assertEqual(
            item,
            {
                "text": "try a smaller level",
                "chat_id": "4242",
                "reply_to": "1234",
                "reply_target": "7",
            },
        )

    def test_a_plain_message_carries_no_reply_target(self) -> None:
        item = inbound_text_item(message("hello"))
        self.assertEqual(
            item, {"text": "hello", "chat_id": "4242", "reply_target": "7"}
        )


class FakeBot:
    """Records each Bot API call and answers with a message id."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, dict]] = []

    def _sent(self, method: str, kwargs: dict):
        self.calls.append((method, kwargs))
        return SimpleNamespace(message_id=500 + len(self.calls))

    async def send_message(self, **kwargs):
        return self._sent("send_message", kwargs)

    async def send_photo(self, **kwargs):
        return self._sent("send_photo", kwargs)

    async def send_video(self, **kwargs):
        return self._sent("send_video", kwargs)


class ReplyParameters:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


class TelegramOutboundTest(unittest.TestCase):
    def setUp(self) -> None:
        fake_telegram = types.ModuleType("telegram")
        fake_telegram.ReplyParameters = ReplyParameters  # type: ignore[attr-defined]
        self._saved = sys.modules.get("telegram")
        sys.modules["telegram"] = fake_telegram
        self._dir = tempfile.TemporaryDirectory()
        self.channel = TelegramChannel(Path(self._dir.name))
        self.bot = FakeBot()
        self.channel._app_instance = SimpleNamespace(bot=self.bot)
        self.channel._allowed_chat_id = "4242"
        self.channel._run_coro = lambda coro, timeout=10.0: asyncio.run(coro)  # type: ignore[method-assign]

    def tearDown(self) -> None:
        if self._saved is None:
            sys.modules.pop("telegram", None)
        else:
            sys.modules["telegram"] = self._saved
        self._dir.cleanup()

    def reply_target(self, call: int) -> dict | None:
        params = self.bot.calls[call][1].get("reply_parameters")
        return params.kwargs if params is not None else None

    def test_a_reply_names_the_message_it_answers(self) -> None:
        result = self.channel.send_reply({"text": "done", "reply_to_message_id": "77"})
        self.assertEqual(result, {"status": "ok", "message_id": 501})
        self.assertEqual(
            self.reply_target(0),
            {"message_id": 77, "allow_sending_without_reply": True},
        )

    def test_a_plain_reply_answers_nothing(self) -> None:
        self.channel.send_reply({"text": "hello"})
        self.assertIsNone(self.reply_target(0))

    def test_photos_and_videos_reply_and_return_their_message_id(self) -> None:
        data = base64.b64encode(b"bytes").decode()
        photo = self.channel.send_photo(
            {"photo": data, "caption": "cover", "reply_to_message_id": "77"}
        )
        video = self.channel.send_video({"video": data, "reply_to_message_id": "77"})
        self.assertEqual(photo, {"status": "ok", "message_id": 501})
        self.assertEqual(video, {"status": "ok", "message_id": 502})
        self.assertEqual(self.reply_target(0)["message_id"], 77)
        self.assertEqual(self.reply_target(1)["message_id"], 77)


if __name__ == "__main__":
    unittest.main()
