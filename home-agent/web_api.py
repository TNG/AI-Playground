"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

Telegram bot polls for incoming messages and queues them for Electron to pick up.
"""

import argparse
import asyncio
import json
import logging
import os
import threading
from pathlib import Path
from typing import Iterator

import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Upstream LLM URL
_upstream_url: str | None = None
_upstream_lock = threading.Lock()

# Telegram state
_last_seen_chat_id: str | None = None
_pending_messages: list[dict] = []
_pending_lock = threading.Lock()

# Reference to the running Application so we can pause/resume its updater
_bot_application = None
_bot_loop: asyncio.AbstractEventLoop | None = None

# Persistent chat ID file — survives restarts
_CHAT_ID_FILE = Path(__file__).parent / ".chat_id"

logger = logging.getLogger(__name__)


def _load_persisted_chat_id() -> str | None:
    try:
        return _CHAT_ID_FILE.read_text().strip() or None
    except FileNotFoundError:
        return None


def _persist_chat_id(chat_id: str) -> None:
    try:
        _CHAT_ID_FILE.write_text(chat_id)
        logger.info("Persisted chat_id=%s to %s", chat_id, _CHAT_ID_FILE)
    except Exception as exc:
        logger.warning("Could not persist chat_id: %s", exc)


# Load persisted chat ID at startup
_last_seen_chat_id: str | None = _load_persisted_chat_id()


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


# ── Upstream control ──────────────────────────────────────────────────────────

@app.post("/set-upstream")
def set_upstream():
    global _upstream_url
    data = request.get_json(silent=True) or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "url is required"}), 400
    with _upstream_lock:
        _upstream_url = url.rstrip("/")
    return jsonify({"status": "ok", "upstream": _upstream_url})


# ── Telegram polling control ──────────────────────────────────────────────────

@app.post("/set-telegram-token")
def set_telegram_token():
    """Inject bot token at runtime to start the polling bot without restart."""
    global _bot_application, _bot_loop
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    chat_id = data.get("chatId", "")
    if not token:
        return jsonify({"error": "token required"}), 400
    if _bot_application is not None:
        return jsonify({"status": "already_running"})
    t = threading.Thread(target=_start_telegram_bot, args=(token, chat_id), daemon=True)
    t.start()
    logger.info("Started Telegram bot via /set-telegram-token")
    return jsonify({"status": "started"})
    """Pause the Telegram bot polling so getUpdates is free for Electron."""
    if _bot_application is not None and _bot_loop is not None:
        future = asyncio.run_coroutine_threadsafe(_bot_application.updater.stop(), _bot_loop)
        try:
            future.result(timeout=8)  # block until actually stopped
            logger.info("Telegram polling paused")
        except Exception as exc:
            logger.warning("pause_polling error: %s", exc)
    return jsonify({"status": "paused"})


@app.post("/resume-polling")
def resume_polling():
    """Resume the Telegram bot polling."""
    if _bot_application is not None and _bot_loop is not None:
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.updater.start_polling(drop_pending_updates=False), _bot_loop
        )
        try:
            future.result(timeout=8)
            logger.info("Telegram polling resumed")
        except Exception as exc:
            logger.warning("resume_polling error: %s", exc)
    return jsonify({"status": "resumed"})


# ── Chat ID detection ─────────────────────────────────────────────────────────

@app.get("/get-chat-id")
def get_chat_id():
    """Return the last chat ID seen by the bot (from memory or persisted file)."""
    mem = _last_seen_chat_id
    persisted = _load_persisted_chat_id()
    logger.info("get-chat-id: memory=%s file=%s file_path=%s file_exists=%s",
                mem, persisted, _CHAT_ID_FILE, _CHAT_ID_FILE.exists())
    chat_id = mem or persisted
    if chat_id:
        return jsonify({"chatId": chat_id})
    return jsonify({"error": "No chat ID detected yet. Send any message to your bot, then click Detect."}), 404


# ── Telegram queue ────────────────────────────────────────────────────────────

@app.get("/poll-telegram")
def poll_telegram():
    """Return and clear all pending Telegram messages."""
    with _pending_lock:
        msgs = list(_pending_messages)
        _pending_messages.clear()
    return jsonify(msgs)


@app.post("/flush-pending")
def flush_pending():
    """Discard all pending messages without processing them (used after chat-ID detection)."""
    with _pending_lock:
        count = len(_pending_messages)
        _pending_messages.clear()
    logger.info("flush-pending: discarded %d messages", count)
    return jsonify({"flushed": count})


@app.post("/send-telegram-reply")
def send_telegram_reply():
    """Send a reply text back to Telegram. Body: { text: str }"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        resp = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text},
            timeout=10,
        )
        if resp.ok:
            return jsonify({"status": "ok"})
        return jsonify({"error": resp.text}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Chat completions proxy ────────────────────────────────────────────────────

@app.post("/v1/chat/completions")
def chat_completions():
    upstream = request.headers.get("X-Upstream-Url")
    with _upstream_lock:
        upstream = upstream or _upstream_url
    if not upstream:
        return jsonify({"error": "No upstream URL provided"}), 400

    upstream_url = upstream.rstrip("/") + "/v1/chat/completions"

    try:
        body = request.get_data()
        headers = {
            k: v
            for k, v in request.headers
            if k.lower() not in ("host", "content-length", "x-upstream-url")
        }

        try:
            parsed = json.loads(body)
            stream = parsed.get("stream", False)
        except Exception:
            stream = False

        upstream_resp = requests.post(
            upstream_url,
            data=body,
            headers=headers,
            stream=stream,
            timeout=None,
        )

        if stream:
            def generate() -> Iterator[bytes]:
                for chunk in upstream_resp.iter_content(chunk_size=None):
                    yield chunk

            return Response(
                stream_with_context(generate()),
                status=upstream_resp.status_code,
                content_type=upstream_resp.headers.get("Content-Type", "text/event-stream"),
            )
        else:
            return Response(
                upstream_resp.content,
                status=upstream_resp.status_code,
                content_type=upstream_resp.headers.get("Content-Type", "application/json"),
            )
    except requests.exceptions.ConnectionError as exc:
        return jsonify({"error": f"Cannot reach upstream: {exc}"}), 502
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Telegram bot ──────────────────────────────────────────────────────────────

def _start_telegram_bot(token: str, allowed_chat_id: str) -> None:
    """Runs the Telegram bot in its own asyncio event loop (daemon thread)."""
    global _bot_application, _bot_loop, _last_seen_chat_id
    from telegram import Update
    from telegram.ext import Application, MessageHandler, filters, ContextTypes

    async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        global _last_seen_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        # Always record the chat ID (even before it's configured) for detection
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        # If no allowed_chat_id configured yet, accept the first sender for detection only
        if not allowed_chat_id:
            logger.info("Detection mode: received message from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allowed_chat_id:
            logger.warning("Ignoring message from unauthorized chat_id: %s", chat_id)
            return
        user_text = update.message.text or ""
        logger.info("Telegram message received: %s", user_text)
        with _pending_lock:
            _pending_messages.append({"text": user_text, "chat_id": chat_id})

    async def run() -> None:
        global _bot_application, _bot_loop, _last_seen_chat_id
        _bot_loop = asyncio.get_event_loop()
        application = Application.builder().token(token).build()
        _bot_application = application
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        await application.initialize()
        await application.start()
        await application.bot.delete_webhook(drop_pending_updates=False)

        # Pre-populate chat ID from pending updates BEFORE polling starts
        # Pre-populate chat ID from pending updates BEFORE polling starts
        try:
            logger.info("Pre-populate: calling getUpdates before polling starts...")
            updates = await application.bot.get_updates(limit=100, timeout=0)
            logger.info("Pre-populate: got %d updates", len(updates))
            for i, u in enumerate(updates):
                logger.info("Pre-populate update[%d]: type=%s message=%s", i, type(u).__name__, u.message)
                cid = None
                if u.message:
                    cid = str(u.message.chat_id)
                elif hasattr(u, 'my_chat_member') and u.my_chat_member:
                    cid = str(u.my_chat_member.chat.id)
                if cid:
                    _last_seen_chat_id = cid
                    _persist_chat_id(cid)
                    logger.info("Pre-populated chat_id from pending updates: %s", cid)
                    break
            if not _last_seen_chat_id:
                # Also check the persisted file
                persisted = _load_persisted_chat_id()
                logger.info("Pre-populate: no chat_id from updates, persisted file has: %s", persisted)
                if persisted:
                    _last_seen_chat_id = persisted
        except Exception as exc:
            logger.warning("Could not pre-populate chat_id: %s", exc, exc_info=True)

        await application.updater.start_polling(drop_pending_updates=False)
        await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _bot_loop = loop
    try:
        loop.run_until_complete(run())
    except Exception as exc:
        logger.error("Telegram bot crashed: %s", exc)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58000)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    print(f"Home Agent backend v2 starting on port {args.port} (chat_id file: {_CHAT_ID_FILE})", flush=True)

    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")  # optional — empty means accept all
    print(f"Telegram config: token={'SET (len='+str(len(tg_token))+')' if tg_token else 'NOT SET'} chat_id={'SET' if tg_chat_id else 'NOT SET'}", flush=True)
    if tg_token:
        print(f"Starting Telegram bot (allowed chat: {tg_chat_id or 'any — detecting'})", flush=True)
        t = threading.Thread(
            target=_start_telegram_bot, args=(tg_token, tg_chat_id), daemon=True
        )
        t.start()
    else:
        print("No TELEGRAM_BOT_TOKEN — Telegram bot disabled.", flush=True)

    print(f"Home Agent backend starting on port {args.port}", flush=True)
    app.run(host="0.0.0.0", port=args.port)

