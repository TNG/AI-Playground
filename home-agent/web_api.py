"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

Telegram bot polls for incoming messages and queues them for Electron to pick up.
"""

import argparse
import asyncio
import logging
import os
import threading
from pathlib import Path

from flask import Flask, jsonify, request
from flask_cors import CORS
from llm_proxy import proxy_chat_completions

app = Flask(__name__)
CORS(app)

# Upstream LLM URL
_upstream_url: str | None = None
_upstream_lock = threading.Lock()

# Telegram state
_pending_messages: list[dict] = []
_pending_lock = threading.Lock()

# Running bot instance + its event loop (set inside _start_telegram_bot)
_bot_application = None  # None | sentinel str "starting" | Application
_bot_loop: asyncio.AbstractEventLoop | None = None
_bot_token: str = ""
_bot_chat_id: str = ""
_bot_start_lock = threading.Lock()

# Persistent chat ID file — survives restarts
_CHAT_ID_FILE = Path(__file__).parent / ".chat_id"
_last_seen_chat_id: str | None = None

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
_last_seen_chat_id = _load_persisted_chat_id()


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
    global _bot_application
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    chat_id = data.get("chatId", "")
    if not token:
        return jsonify({"error": "token required"}), 400
    with _bot_start_lock:
        if _bot_application is not None:
            return jsonify({"status": "already_running"})
        _bot_application = "starting"  # sentinel: blocks concurrent requests
    t = threading.Thread(target=_start_telegram_bot, args=(token, chat_id), daemon=True)
    t.start()
    logger.info("Started Telegram bot via /set-telegram-token")
    return jsonify({"status": "started"})


# ── Chat ID detection ─────────────────────────────────────────────────────────

@app.get("/get-chat-id")
def get_chat_id():
    """Return the last chat ID seen by the bot (from memory or persisted file)."""
    chat_id = _last_seen_chat_id or _load_persisted_chat_id()
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
    """Send a reply text back to Telegram. Body: { text: str, parse_mode?: str }"""
    data = request.get_json(silent=True) or {}
    text = data.get("text", "")
    parse_mode = data.get("parse_mode") or None
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not _bot_chat_id:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_message(chat_id=_bot_chat_id, text=text, parse_mode=parse_mode),
            _bot_loop,
        )
        future.result(timeout=10)
        return jsonify({"status": "ok"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


@app.post("/send-telegram-photo")
def send_telegram_photo():
    """Send a photo back to Telegram. Body: { photo: <base64 str>, caption: str }"""
    import base64
    data = request.get_json(silent=True) or {}
    photo_b64 = data.get("photo", "")
    caption = data.get("caption", "")
    if not _bot_application or _bot_application == "starting" or not _bot_loop or not _bot_chat_id:
        return jsonify({"error": "Telegram not configured"}), 400
    try:
        photo_bytes = base64.b64decode(photo_b64)
        future = asyncio.run_coroutine_threadsafe(
            _bot_application.bot.send_photo(
                chat_id=_bot_chat_id,
                photo=photo_bytes,
                caption=caption or None,
            ),
            _bot_loop,
        )
        future.result(timeout=30)
        return jsonify({"status": "ok"})
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
    return proxy_chat_completions(upstream, request)


# ── Telegram bot ──────────────────────────────────────────────────────────────

def _start_telegram_bot(token: str, allowed_chat_id: str) -> None:
    """Runs the Telegram bot in its own asyncio event loop (daemon thread)."""
    global _bot_application, _bot_loop, _last_seen_chat_id, _bot_token, _bot_chat_id
    from telegram import Update
    from telegram.ext import Application, MessageHandler, filters, ContextTypes

    _bot_token = token
    _bot_chat_id = allowed_chat_id

    async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        global _last_seen_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        if not allowed_chat_id:
            logger.info("Detection mode: received message from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allowed_chat_id:
            logger.warning("Ignoring message from unauthorized chat_id: %s", chat_id)
            return
        user_text = update.message.text or ""
        logger.info(
            "Telegram message received: chat_id=%s message_id=%s length=%d",
            chat_id,
            update.message.message_id,
            len(user_text),
        )
        with _pending_lock:
            _pending_messages.append({"text": user_text, "chat_id": chat_id})

    async def handle_help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /help — queue a special help marker for the frontend to reply with."""
        global _last_seen_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        if not allowed_chat_id:
            return
        if chat_id != allowed_chat_id:
            logger.warning("Ignoring /help from unauthorized chat_id: %s", chat_id)
            return
        logger.info("Telegram /help command received: chat_id=%s", chat_id)
        with _pending_lock:
            _pending_messages.append({"text": "/help", "chat_id": chat_id})

    async def handle_imggen_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        """Handle /imgGen <prompt> as a Telegram command."""
        global _last_seen_chat_id
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        if _last_seen_chat_id != chat_id:
            _last_seen_chat_id = chat_id
            _persist_chat_id(chat_id)
        if not allowed_chat_id:
            logger.info("Detection mode: received /imgGen from chat_id=%s (not yet configured)", chat_id)
            return
        if chat_id != allowed_chat_id:
            logger.warning("Ignoring /imgGen from unauthorized chat_id: %s", chat_id)
            return
        # Reconstruct text as "/imgGen <args>" so the frontend routing works uniformly
        args = context.args or []
        prompt_part = " ".join(args)
        full_text = f"/imgGen {prompt_part}".strip()
        logger.info(
            "Telegram /imgGen command received: chat_id=%s prompt=%r",
            chat_id,
            prompt_part,
        )
        with _pending_lock:
            _pending_messages.append({"text": full_text, "chat_id": chat_id})

    async def run() -> None:
        global _bot_application, _bot_loop, _last_seen_chat_id
        _bot_loop = asyncio.get_event_loop()
        application = Application.builder().token(token).build()
        _bot_application = application
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        from telegram.ext import CommandHandler
        application.add_handler(CommandHandler("imgGen", handle_imggen_command))
        application.add_handler(CommandHandler("help", handle_help_command))
        await application.initialize()
        await application.start()
        await application.bot.delete_webhook(drop_pending_updates=False)

        # Pre-populate chat ID from any pending updates before polling starts,
        # then acknowledge them so start_polling does not re-deliver them.
        try:
            updates = await application.bot.get_updates(limit=100, timeout=0)
            if updates:
                cid = next(
                    (str(u.message.chat_id) for u in updates if u.message),
                    None,
                )
                if cid:
                    _last_seen_chat_id = cid
                    _persist_chat_id(cid)
                    logger.info("Pre-populated chat_id from pending updates: %s", cid)
                # Acknowledge all fetched updates so polling won't re-process them
                highest_update_id = max(u.update_id for u in updates)
                await application.bot.get_updates(offset=highest_update_id + 1, limit=1, timeout=0)
                logger.info("Acknowledged updates up to update_id=%d", highest_update_id)
            if not _last_seen_chat_id:
                _last_seen_chat_id = _load_persisted_chat_id()
        except Exception as exc:
            logger.warning("Could not pre-populate chat_id: %s", exc)

        await application.updater.start_polling(drop_pending_updates=False)
        await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _bot_loop = loop
    try:
        loop.run_until_complete(run())
    except Exception as exc:
        logger.error("Telegram bot crashed: %s", exc)
        _bot_application = None  # allow retry


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58000)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO)
    print(f"Home Agent backend starting on port {args.port} (chat_id file: {_CHAT_ID_FILE})", flush=True)

    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    print(f"Telegram config: token={'SET' if tg_token else 'NOT SET'} chat_id={'SET' if tg_chat_id else 'NOT SET'}", flush=True)
    if tg_token:
        print(f"Starting Telegram bot (allowed chat: {tg_chat_id or 'any — detecting'})", flush=True)
        threading.Thread(target=_start_telegram_bot, args=(tg_token, tg_chat_id), daemon=True).start()
    else:
        print("No TELEGRAM_BOT_TOKEN — Telegram bot disabled.", flush=True)

    app.run(host="0.0.0.0", port=args.port)  # nosec B104 — intentional: local service must bind all interfaces for Electron IPC

