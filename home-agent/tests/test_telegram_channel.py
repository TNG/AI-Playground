"""Telegram inbound messages as the renderer receives them from the poll queue,
and the outbound sends the Answer flow relies on.

Stdlib only; python-telegram-bot is not needed, since a message is read through
its attributes and stood in for by a namespace, and the bot is a recording fake.
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

from channels.telegram import (
    TelegramChannel,
    answer_callback_item,
    inbound_item,
    inbound_text_item,
    refused_document_item,
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

    def test_a_voice_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        voice = [{"mime": "audio/ogg", "data_base64": "T2dn"}]
        item = inbound_item(message("", reply_to_id=1234), "", audio=voice)
        self.assertEqual(
            item,
            {
                "text": "",
                "chat_id": "4242",
                "audio": voice,
                "reply_to": "1234",
                "reply_target": "7",
            },
        )

    def test_a_photo_reply_carries_the_id_of_the_message_it_answers(self) -> None:
        photo = [{"mime": "image/jpeg", "data_base64": "/9j/"}]
        item = inbound_item(message("", reply_to_id=1234), "[image]", images=photo)
        self.assertEqual(
            item,
            {
                "text": "[image]",
                "chat_id": "4242",
                "images": photo,
                "reply_to": "1234",
                "reply_target": "7",
            },
        )

    def test_a_document_without_a_reply_carries_no_reply_target(self) -> None:
        doc = [{"filename": "level.txt", "mime": "text/plain", "data_base64": "YQ=="}]
        item = inbound_item(message(""), "levels", documents=doc)
        self.assertEqual(
            item,
            {
                "text": "levels",
                "chat_id": "4242",
                "documents": doc,
                "reply_target": "7",
            },
        )

    def test_a_refused_document_replying_to_a_message_is_queued_with_its_notice(
        self,
    ) -> None:
        doc_reply = message("", reply_to_id=1234)
        doc_reply.caption = "here"
        item = refused_document_item(doc_reply, "Unsupported document type.")
        self.assertEqual(
            item,
            {
                "text": "here",
                "chat_id": "4242",
                "refused": "Unsupported document type.",
                "reply_to": "1234",
                "reply_target": "7",
            },
        )

    def test_a_refused_document_replying_to_nothing_is_queued_with_its_notice(
        self,
    ) -> None:
        doc = message("")
        doc.caption = None
        item = refused_document_item(doc, "Unsupported document type.")
        self.assertEqual(item["refused"], "Unsupported document type.")
        self.assertNotIn("reply_to", item)

    def test_an_answer_tap_names_the_message_the_button_is_under(self) -> None:
        tapped = SimpleNamespace(chat_id=4242, message_id=1234)
        item = answer_callback_item(SimpleNamespace(data="answer", message=tapped))
        self.assertEqual(
            item, {"chat_id": "4242", "callback": "answer", "reply_to": "1234"}
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

    async def send_voice(self, **kwargs):
        return self._sent("send_voice", kwargs)

    async def send_document(self, **kwargs):
        return self._sent("send_document", kwargs)


class ReplyParameters:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs


class TelegramOutboundTest(unittest.TestCase):
    def setUp(self) -> None:
        fake_telegram = types.ModuleType("telegram")
        fake_telegram.ReplyParameters = ReplyParameters  # type: ignore[attr-defined]
        fake_telegram.InputFile = lambda file, filename: (file.read(), filename)  # type: ignore[attr-defined]
        fake_telegram.InlineKeyboardButton = SimpleNamespace  # type: ignore[attr-defined]
        fake_telegram.ForceReply = SimpleNamespace  # type: ignore[attr-defined]
        fake_telegram.InlineKeyboardMarkup = lambda rows: rows  # type: ignore[attr-defined]
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

    def test_a_reply_with_an_answer_button_names_the_message_it_answers(self) -> None:
        result = self.channel.send_keyboard(
            {
                "text": "done",
                "buttons": [[{"text": "💬 Answer", "callback_data": "answer"}]],
                "reply_to_message_id": "77",
            }
        )
        self.assertEqual(result, {"status": "ok", "message_id": 501})
        self.assertEqual(self.reply_target(0)["message_id"], 77)

    def test_a_start_prompt_request_opens_the_reply_box_with_its_hint(self) -> None:
        result = self.channel.send_post(
            {"text": "What should it do?", "force_reply_placeholder": "Start Prompt"}
        )
        self.assertEqual(result, {"status": "ok", "message_id": 501})
        markup = self.bot.calls[0][1]["reply_markup"]
        self.assertEqual(markup.input_field_placeholder, "Start Prompt")

    def test_a_reply_box_hint_is_cut_to_what_telegram_accepts(self) -> None:
        self.channel.send_post({"text": "?", "force_reply_placeholder": "x" * 80})
        markup = self.bot.calls[0][1]["reply_markup"]
        self.assertEqual(markup.input_field_placeholder, "x" * 64)

    def test_a_post_opens_no_reply_box_unless_asked(self) -> None:
        self.channel.send_post({"text": "Downloading…"})
        self.assertNotIn("reply_markup", self.bot.calls[0][1])

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

    def test_a_voice_memo_is_captioned_replies_and_returns_its_message_id(self) -> None:
        ogg = base64.b64encode(b"OggS").decode()
        voice = self.channel.send_voice(
            {
                "audio": ogg,
                "mime": "audio/ogg",
                "caption": "summary",
                "reply_to_message_id": "77",
            }
        )
        self.assertEqual(voice, {"status": "ok", "message_id": 501})
        method, kwargs = self.bot.calls[0]
        self.assertEqual(method, "send_voice")
        self.assertEqual(kwargs["caption"], "summary")
        self.assertEqual(kwargs["voice"], b"OggS")
        self.assertEqual(self.reply_target(0)["message_id"], 77)

    def test_a_document_keeps_its_name_replies_and_returns_its_message_id(self) -> None:
        glb = base64.b64encode(b"glTF").decode()
        document = self.channel.send_document(
            {"document": glb, "filename": "ship.glb", "reply_to_message_id": "77"}
        )
        self.assertEqual(document, {"status": "ok", "message_id": 501})
        method, kwargs = self.bot.calls[0]
        self.assertEqual(method, "send_document")
        self.assertEqual(kwargs["document"], (b"glTF", "ship.glb"))
        self.assertIsNone(kwargs["caption"])
        self.assertEqual(self.reply_target(0)["message_id"], 77)

    def test_every_media_caption_is_sent_in_the_parse_mode_it_was_given(self) -> None:
        data = base64.b64encode(b"OggS").decode()
        formatted = {"caption": "<b>done</b>", "parse_mode": "HTML"}
        self.channel.send_photo({"photo": data, **formatted})
        self.channel.send_video({"video": data, **formatted})
        self.channel.send_voice({"audio": data, "mime": "audio/ogg", **formatted})
        self.channel.send_document({"document": data, **formatted})
        self.assertEqual(
            [
                (method, kwargs["caption"], kwargs["parse_mode"])
                for method, kwargs in self.bot.calls
            ],
            [
                ("send_photo", "<b>done</b>", "HTML"),
                ("send_video", "<b>done</b>", "HTML"),
                ("send_voice", "<b>done</b>", "HTML"),
                ("send_document", "<b>done</b>", "HTML"),
            ],
        )

    def test_a_caption_with_no_parse_mode_is_plain_text(self) -> None:
        data = base64.b64encode(b"bytes").decode()
        self.channel.send_photo({"photo": data, "caption": "*x*"})
        self.assertIsNone(self.bot.calls[0][1]["parse_mode"])


if __name__ == "__main__":
    unittest.main()
