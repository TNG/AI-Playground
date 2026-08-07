"""Local web channel — serves a password-protected browser chat over HTTP + SSE.

This is the Python peer of Telegram and Slack: it satisfies the same `Channel`
protocol and is dispatched through the identical generic `/channel/<kind>/*`
Flask routes, so the renderer drives it with the same poll/send bridge. The
difference is only the transport — instead of talking to a cloud bot API, it
stands up a small HTTP server (in its own daemon thread, mirroring how the
Telegram channel runs its asyncio loop in a thread) that:

  * serves a self-contained chat page (`local_web_app_html.py`) to browsers on
    `localhost` — or the whole LAN when `allowLan` is set,
  * accepts inbound messages via `POST /api/chat` (guarded by a password login
    that mints an `HttpOnly` session cookie), queued for `poll()`,
  * pushes outbound replies/drafts/photos/keyboards to every connected browser
    over Server-Sent Events (`GET /api/events`). Each `send_*` broadcasts one
    `{action, ...payload}` SSE event, which the page renders natively.

Because the server lives inside the home-agent backend, `local-web` activates
exactly like the other channels (needs the backend available + verified) — there
is no separate Electron-side process.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import secrets
import threading
from collections.abc import Iterable
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .base import ChannelBase
from .local_web_app_html import LOCAL_WEB_CHAT_APP_HTML
from .types import SendResult

logger = logging.getLogger(__name__)

_SESSION_COOKIE = "aipg_local_web"
_SESSION_MAX_AGE = 60 * 60 * 24 * 7  # 7 days
# Sentinel pushed onto an SSE client's queue to make its handler thread exit
# (server restart / shutdown). A plain object() is unambiguous vs. real events.
_SSE_STOP = object()


class LocalWebChannel(ChannelBase):
    """Single HTTP+SSE chat server behind the `Channel` protocol."""

    def __init__(self, base_dir: Path) -> None:
        super().__init__(
            kind="local-web", identity_file=base_dir / ".local_web_session"
        )
        self._port: int = 0
        self._password: str = ""
        self._allow_lan: bool = False
        self._server: ThreadingHTTPServer | None = None
        # Set of live SSE client queues; broadcast() fans events out to each.
        self._sse_clients: set[queue.Queue] = set()
        self._sse_lock = threading.Lock()
        # Session ids that have authenticated with the password.
        self._sessions: set[str] = set()

    # ── Channel protocol: lifecycle ───────────────────────────────────────
    def set_config(self, config: dict) -> dict:
        """Start (or restart) the server with `{port, password, allowLan}`.

        Mirrors the Telegram/Slack `set_config` bookkeeping: unchanged config on
        a running server short-circuits with `already_running`; any change tears
        the server down and rebinds so the new port/password take effect.

        The whole start is done under `_start_lock` (binding a socket is cheap),
        so two concurrent callers — the renderer's auto-inject watcher and the
        wizard's explicit verify both POST `/config` on Save & start — serialize:
        the first binds the server, the second blocks on the lock and then sees
        it already running (`already_running`) instead of racing the transient
        "starting" state and getting a spurious 409.
        """
        password = (config.get("password") or "").strip()
        if not password:
            return {"error": "password required", "_http_status": 400}
        try:
            port = int(config.get("port") or 8765)
        except (TypeError, ValueError):
            return {"error": "port must be an integer", "_http_status": 400}
        if port < 1024 or port > 65535:
            return {"error": "port must be between 1024 and 65535", "_http_status": 400}
        allow_lan = str(config.get("allowLan", "")).strip().lower() == "true"

        with self._start_lock:
            if self._server is not None:
                unchanged = (
                    self._port == port
                    and self._password == password
                    and self._allow_lan == allow_lan
                )
                if unchanged:
                    return {"status": "already_running"}
                logger.info("Local web config changed — restarting server")
                self._stop_server()
            self._app_instance = "starting"
            try:
                self._start_server(port, password, allow_lan)
            except OSError as exc:
                self._app_instance = None
                logger.error("Local web server failed to bind port %d: %s", port, exc)
                return {
                    "error": f"could not bind port {port}: {exc}",
                    "_http_status": 500,
                }
        return {"status": "started"}

    def request_shutdown(self) -> None:
        with self._start_lock:
            self._stop_server()

    # ── Channel protocol: identity ────────────────────────────────────────
    def get_identity(self) -> str | None:
        # The local web chat has no per-user identity like a chat id — a single
        # shared password gates access. Report a stable sentinel so the renderer
        # (which threads `identity` back into config) has a non-null value.
        return "local"

    # ── Channel protocol: outbound sends ──────────────────────────────────
    # Every send action is the same shape for this transport: broadcast one SSE
    # event `{action, ...payload}` that the browser page renders. The renderer
    # already speaks these action names (see localWebAdapter.ts).
    def _broadcast(self, action: str, payload: dict) -> SendResult:
        if not self.is_running():
            return {"error": "Local web not configured", "_http_status": 400}
        event = {
            "action": action,
            **{k: v for k, v in payload.items() if k != "action"},
        }
        data = json.dumps(event)
        dead: list[queue.Queue] = []
        with self._sse_lock:
            clients = list(self._sse_clients)
        for q in clients:
            try:
                q.put_nowait(data)
            except Exception:
                dead.append(q)
        if dead:
            with self._sse_lock:
                for q in dead:
                    self._sse_clients.discard(q)
        return {"status": "ok"}

    def send_reply(self, payload: dict) -> SendResult:
        return self._broadcast("reply", payload)

    def send_update(self, payload: dict) -> SendResult:
        return self._broadcast("update", payload)

    def send_photo(self, payload: dict) -> SendResult:
        # Normalize the base64 key the adapter uses (`base64`) plus the legacy
        # `photo`/`imageBase64` spellings, so the browser's `d.base64` renders.
        base64_data = (
            payload.get("base64")
            or payload.get("photo")
            or payload.get("imageBase64")
            or ""
        )
        return self._broadcast(
            "photo", {"base64": base64_data, "caption": payload.get("caption", "")}
        )

    def send_video(self, payload: dict) -> SendResult:
        # The browser renders a native <video> from the base64 payload.
        base64_data = payload.get("base64") or payload.get("video") or ""
        return self._broadcast(
            "video",
            {
                "base64": base64_data,
                "caption": payload.get("caption", ""),
                "filename": payload.get("filename", ""),
            },
        )

    def send_voice(self, payload: dict) -> SendResult:
        # Rendered as a native <audio> player in the browser.
        base64_data = payload.get("base64") or payload.get("audio") or ""
        return self._broadcast(
            "voice",
            {"base64": base64_data, "mime": payload.get("mime", "audio/ogg")},
        )

    def send_document(self, payload: dict) -> SendResult:
        # Offered as a download link (the browser can't preview arbitrary files).
        base64_data = payload.get("base64") or payload.get("document") or ""
        return self._broadcast(
            "document",
            {
                "base64": base64_data,
                "filename": payload.get("filename", "file"),
                "caption": payload.get("caption", ""),
            },
        )

    def send_typing(self, payload: dict) -> SendResult:
        return self._broadcast("typing", {"action": payload.get("action") or "typing"})

    def send_keyboard(self, payload: dict) -> SendResult:
        result = self._broadcast(
            "keyboard",
            {"text": payload.get("text", ""), "buttons": payload.get("buttons", [])},
        )
        # Match the other channels' contract: return a handle the renderer can
        # use to settle the prompt in place. The browser edits by re-rendering,
        # so any stable ref works.
        if "error" not in result:
            result["message_id"] = 0
        return result

    def send_edit_message(self, payload: dict) -> SendResult:
        # No in-place edit primitive over SSE; post the settled text as a reply.
        return self._broadcast("reply", {"text": payload.get("text", "")})

    def send_history(self, payload: dict) -> SendResult:
        # Repaint the browser log with a conversation's full transcript. Unlike
        # Telegram/Slack the page keeps no history across (re)connects, so loading
        # a chat re-sends every message as one `history` event.
        return self._broadcast("history", {"messages": payload.get("messages", [])})

    # ── Channel protocol: logging ─────────────────────────────────────────
    def redaction_patterns(self) -> Iterable[re.Pattern[str]]:
        # The password is never logged; nothing token-shaped to scrub globally.
        return ()

    # ── Inbound / auth helpers (used by the request handler) ──────────────
    def _authenticate(self, password: str) -> str | None:
        if not password or password != self._password:
            return None
        session = secrets.token_hex(32)
        self._sessions.add(session)
        return session

    def _is_authenticated(self, session: str | None) -> bool:
        return bool(session) and session in self._sessions

    def _logout(self, session: str | None) -> None:
        if session:
            self._sessions.discard(session)

    def _enqueue_inbound(
        self,
        text: str | None,
        callback: str | None,
        client_id: str,
        images: list | None = None,
        audio: list | None = None,
        documents: list | None = None,
    ) -> None:
        item: dict = {"chat_id": client_id, "channel": "local-web"}
        if text is not None:
            item["text"] = text
        if callback is not None:
            item["callback"] = callback
        # Attachments uploaded from the browser (base64), shaped like the other
        # channels' inbound so the renderer's image/audio/document handling — RAG
        # ingest, vision, transcription — applies unchanged.
        if images:
            item["images"] = images
        if audio:
            item["audio"] = audio
        if documents:
            item["documents"] = documents
        self.queue_append(item)

    def _register_sse(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=256)
        with self._sse_lock:
            self._sse_clients.add(q)
        return q

    def _unregister_sse(self, q: queue.Queue) -> None:
        with self._sse_lock:
            self._sse_clients.discard(q)

    # ── Server lifecycle implementation ───────────────────────────────────
    def _start_server(self, port: int, password: str, allow_lan: bool) -> None:
        self._port = port
        self._password = password
        self._allow_lan = allow_lan
        self._sessions.clear()
        host = "0.0.0.0" if allow_lan else "127.0.0.1"

        channel = self

        class Handler(_LocalWebRequestHandler):
            pass

        server = ThreadingHTTPServer((host, port), Handler)
        server.daemon_threads = True
        server.channel = channel  # type: ignore[attr-defined]
        self._server = server
        self._app_instance = server

        t = threading.Thread(
            target=server.serve_forever, name="local-web-server", daemon=True
        )
        self._thread = t
        t.start()
        logger.info(
            "Local web Home Agent listening on %s:%d (allowLan=%s)",
            host,
            port,
            allow_lan,
        )

    def _stop_server(self) -> None:
        """Tear the server down and release all SSE handler threads."""
        server = self._server
        # Wake every SSE handler so its thread returns instead of blocking on
        # the client queue forever.
        with self._sse_lock:
            clients = list(self._sse_clients)
            self._sse_clients.clear()
        for q in clients:
            try:
                q.put_nowait(_SSE_STOP)
            except Exception:
                pass
        self._sessions.clear()
        self.flush_pending()
        if server is not None:
            # shutdown() blocks until serve_forever() returns; run it off the
            # current thread so we never deadlock if called from a handler.
            threading.Thread(
                target=self._shutdown_server, args=(server,), daemon=True
            ).start()
        self._server = None
        self._app_instance = None

    @staticmethod
    def _shutdown_server(server: ThreadingHTTPServer) -> None:
        try:
            server.shutdown()
        except Exception as exc:
            logger.warning("Local web server.shutdown() failed: %s", exc)
        try:
            server.server_close()
        except Exception as exc:
            logger.warning("Local web server.server_close() failed: %s", exc)


class _LocalWebRequestHandler(BaseHTTPRequestHandler):
    """Stdlib HTTP handler bound to a `LocalWebChannel` via `server.channel`.

    One instance per request (ThreadingHTTPServer spawns a thread per connection),
    so `/api/events` can block its own thread streaming SSE without stalling other
    requests.
    """

    protocol_version = "HTTP/1.1"

    # ── plumbing ──────────────────────────────────────────────────────────
    @property
    def _channel(self) -> LocalWebChannel:
        return self.server.channel  # type: ignore[attr-defined]

    def log_message(self, format: str, *args) -> None:
        # Route through the module logger (and keep the password out of logs).
        logger.debug("local-web %s", format % args)

    def _session(self) -> str | None:
        raw = self.headers.get("Cookie")
        if not raw:
            return None
        jar = SimpleCookie()
        try:
            jar.load(raw)
        except Exception:
            return None
        morsel = jar.get(_SESSION_COOKIE)
        return morsel.value if morsel else None

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0:
            return {}
        try:
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            return {}

    def _send_json(
        self, status: int, body: dict, extra_headers: dict | None = None
    ) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    def _client_id(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return (
            self.client_address[0] if self.client_address else "unknown"
        ) or "unknown"

    # ── routes ──────────────────────────────────────────────────────────
    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            body = LOCAL_WEB_CHAT_APP_HTML.encode("utf-8")
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/api/health":
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        if path == "/api/session":
            self._send_json(
                HTTPStatus.OK, {"ok": self._channel._is_authenticated(self._session())}
            )
            return
        if path == "/api/events":
            self._serve_sse()
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        path = self.path.split("?", 1)[0]
        channel = self._channel
        if path == "/api/login":
            body = self._read_json()
            session = channel._authenticate((body.get("password") or "").strip())
            if session is None:
                self._send_json(
                    HTTPStatus.UNAUTHORIZED, {"ok": False, "error": "invalid_password"}
                )
                return
            cookie = (
                f"{_SESSION_COOKIE}={session}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={_SESSION_MAX_AGE}"
            )
            self._send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})
            return
        if path == "/api/logout":
            channel._logout(self._session())
            cookie = f"{_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
            self._send_json(HTTPStatus.OK, {"ok": True}, {"Set-Cookie": cookie})
            return
        if path == "/api/chat":
            if not channel._is_authenticated(self._session()):
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
                return
            body = self._read_json()
            text = body.get("text")
            callback = body.get("callback")

            def _list(key: str) -> list | None:
                value = body.get(key)
                return value if isinstance(value, list) and value else None

            channel._enqueue_inbound(
                text if isinstance(text, str) else None,
                callback if isinstance(callback, str) else None,
                self._client_id(),
                images=_list("images"),
                audio=_list("audio"),
                documents=_list("documents"),
            )
            self._send_json(HTTPStatus.OK, {"ok": True})
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def _serve_sse(self) -> None:
        channel = self._channel
        if not channel._is_authenticated(self._session()):
            self.send_error(HTTPStatus.UNAUTHORIZED)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        q = channel._register_sse()
        try:
            self.wfile.write(b": connected\n\n")
            self.wfile.flush()
            while True:
                try:
                    item = q.get(timeout=20)
                except queue.Empty:
                    # Heartbeat comment keeps proxies / the socket alive and
                    # lets us notice a dropped client via the write error.
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    continue
                if item is _SSE_STOP:
                    break
                self.wfile.write(f"data: {item}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            channel._unregister_sse(q)
