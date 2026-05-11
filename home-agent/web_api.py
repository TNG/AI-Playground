"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

The upstream URL is resolved by the frontend (textInference store) and passed as:
  - header:    X-Upstream-Url: http://localhost:39001
  - or via POST /set-upstream { "url": "http://localhost:39001" }

Telegram bot (optional): set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars.
"""

import argparse
import asyncio
import json
import logging
import os
import threading
from typing import Iterator

import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# Shared upstream URL — updated via /set-upstream or X-Upstream-Url header
_upstream_url: str | None = None
_upstream_lock = threading.Lock()

# Queue of pending Telegram messages waiting to be consumed by Electron
_pending_messages: list[dict] = []
_pending_lock = threading.Lock()

logger = logging.getLogger(__name__)


# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


# ── Dynamic upstream control ──────────────────────────────────────────────────

@app.get("/poll-telegram")
def poll_telegram():
    """Return and clear all pending Telegram messages."""
    with _pending_lock:
        msgs = list(_pending_messages)
        _pending_messages.clear()
    return jsonify(msgs)


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
    global _upstream_url
    data = request.get_json(silent=True) or {}
    url = data.get("url")
    if not url:
        return jsonify({"error": "url is required"}), 400
    with _upstream_lock:
        _upstream_url = url.rstrip("/")
    return jsonify({"status": "ok", "upstream": _upstream_url})


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


# ── Telegram bot (optional) ───────────────────────────────────────────────────


def _start_telegram_bot(token: str, allowed_chat_id: str) -> None:
    """Runs the Telegram bot in its own asyncio event loop (daemon thread)."""
    from telegram import Update
    from telegram.ext import Application, MessageHandler, filters, ContextTypes

    async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
        if update.message is None:
            return
        chat_id = str(update.message.chat_id)
        if chat_id != allowed_chat_id:
            logger.warning("Ignoring message from unauthorized chat_id: %s", chat_id)
            return
        user_text = update.message.text or ""
        logger.info("Telegram message received: %s", user_text)
        # Push to queue for Electron to pick up via /poll-telegram
        with _pending_lock:
            _pending_messages.append({"text": user_text, "chat_id": chat_id})

    async def run() -> None:
        application = Application.builder().token(token).build()
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
        await application.initialize()
        await application.start()
        # Drop webhook before polling to avoid 409 conflicts
        await application.bot.delete_webhook(drop_pending_updates=False)
        await application.updater.start_polling(drop_pending_updates=False)
        # keep running until the process exits
        await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
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

    # Start Telegram bot if credentials are present
    tg_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    tg_chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if tg_token and tg_chat_id:
        print(f"Starting Telegram bot (allowed chat: {tg_chat_id})", flush=True)
        t = threading.Thread(
            target=_start_telegram_bot, args=(tg_token, tg_chat_id), daemon=True
        )
        t.start()
    else:
        print("No TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID — Telegram bot disabled.", flush=True)

    print(f"Home Agent backend starting on port {args.port}", flush=True)
    app.run(host="0.0.0.0", port=args.port)

