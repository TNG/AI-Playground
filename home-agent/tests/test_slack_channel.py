"""Slack inbound DMs as the renderer receives them from the poll queue.

Stdlib only; slack-bolt is not needed, since an inbound DM is a plain event dict.
"""

from __future__ import annotations

import asyncio
import base64
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from channels import slack
from channels.slack import SlackChannel, inbound_item

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


class FakeClient:
    """Slack shares an uploaded file as a message; its `ts` sits under the file's shares."""

    def __init__(self, shared_at_upload: bool = True) -> None:
        self.uploads: list[dict] = []
        self.shared_at_upload = shared_at_upload
        self.unshared_lookups = 0
        self.lookups = 0
        self.opened: list[str] = []
        self.posts: list[dict] = []

    def _file(self, shared: bool) -> dict:
        shares = {"private": {IM: [{"ts": "1700.0099"}]}} if shared else {}
        return {"id": "F1", "shares": shares}

    async def files_upload_v2(self, **kwargs):
        self.uploads.append(kwargs)
        return {"ok": True, "files": [self._file(self.shared_at_upload)]}

    async def chat_postMessage(self, **kwargs):
        self.posts.append(kwargs)
        return {"ok": True, "ts": "1700.0100", "channel": IM}

    async def conversations_open(self, **kwargs):
        self.opened.append(kwargs["users"])
        return {"ok": True, "channel": {"id": IM}}

    async def files_info(self, **kwargs):
        self.lookups += 1
        return {"ok": True, "file": self._file(self.lookups > self.unshared_lookups)}


class SlackOutboundTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.channel = SlackChannel(Path(self._dir.name))
        self.client = FakeClient()
        self.channel._app_instance = SimpleNamespace(client=self.client)
        self.channel._run_coro = lambda coro, timeout=10.0: asyncio.run(coro)  # type: ignore[method-assign]
        delays = mock.patch.object(slack, "_SHARE_LOOKUP_DELAYS", (0.0, 0.0, 0.0))
        delays.start()
        self.addCleanup(delays.stop)

    def tearDown(self) -> None:
        self._dir.cleanup()

    def test_a_voice_clip_is_uploaded_with_its_caption_in_the_thread(self) -> None:
        mp3 = base64.b64encode(b"ID3").decode()
        result = self.channel.send_voice(
            {
                "audio": mp3,
                "mime": "audio/mpeg",
                "caption": "summary",
                "thread_ts": "1700.0001",
                "channel": IM,
            }
        )
        self.assertEqual(result["status"], "ok")
        upload = self.client.uploads[0]
        self.assertEqual(upload["file"], b"ID3")
        self.assertEqual(upload["initial_comment"], "summary")
        self.assertEqual(upload["thread_ts"], "1700.0001")
        self.assertTrue(upload["filename"].endswith(".mp3"))

    def test_each_attachment_answers_with_the_message_it_posted(self) -> None:
        for action, key in (("photo", "photo"), ("video", "video"), ("voice", "audio")):
            with self.subTest(action=action):
                result = getattr(self.channel, f"send_{action}")(
                    {
                        key: base64.b64encode(b"ID3").decode(),
                        "mime": "audio/mpeg",
                        "channel": IM,
                    }
                )
                self.assertEqual(result["ts"], "1700.0099")
                self.assertEqual(result["channel"], IM)

    def test_an_upload_shared_later_is_looked_up_for_its_message(self) -> None:
        self.client.shared_at_upload = False
        result = self.channel.send_photo(
            {"photo": base64.b64encode(b"png").decode(), "channel": IM}
        )
        self.assertEqual(result["ts"], "1700.0099")

    def test_an_upload_shared_after_a_few_lookups_still_answers_with_its_message(
        self,
    ) -> None:
        self.client.shared_at_upload = False
        self.client.unshared_lookups = 2
        result = self.channel.send_photo(
            {"photo": base64.b64encode(b"png").decode(), "channel": IM}
        )
        self.assertEqual(result["ts"], "1700.0099")
        self.assertEqual(self.client.lookups, 3)

    def test_an_upload_never_shared_answers_without_a_message(self) -> None:
        self.client.shared_at_upload = False
        self.client.unshared_lookups = 99
        with self.assertLogs("channels.slack", level="WARNING"):
            result = self.channel.send_photo(
                {"photo": base64.b64encode(b"png").decode(), "channel": IM}
            )
        self.assertEqual(result, {"status": "ok"})
        self.assertEqual(self.client.lookups, 3)

    def test_an_upload_before_any_dm_goes_to_the_dm_not_the_user_id(self) -> None:
        self.channel._allowed_user_id = USER
        for _ in range(2):
            self.channel.send_photo({"photo": base64.b64encode(b"png").decode()})
        self.assertEqual([u["channel"] for u in self.client.uploads], [IM, IM])
        self.assertEqual(self.client.opened, [USER])

    def test_a_question_asked_for_an_answer_is_posted_in_its_thread(self) -> None:
        self.channel.send_keyboard(
            {"text": "Download?", "blocks": [], "thread_ts": "1700.0001", "channel": IM}
        )
        self.assertEqual(self.client.posts[0]["thread_ts"], "1700.0001")


if __name__ == "__main__":
    unittest.main()
