"""
Home Agent Backend - thin proxy forwarding /v1/chat/completions to llamaCPP / OpenVINO.

The upstream URL is resolved by the frontend (textInference store) and passed as:
  - query param:  ?upstream=http://localhost:39001
  - or header:    X-Upstream-Url: http://localhost:39001
"""

import argparse
import json
from typing import Iterator

import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from flask_cors import CORS

app = Flask(__name__)
CORS(app)


@app.get("/healthy")
def healthy():
    return jsonify({"status": "ok"})


@app.post("/v1/chat/completions")
def chat_completions():
    upstream = request.args.get("upstream") or request.headers.get("X-Upstream-Url")
    if not upstream:
        return jsonify({"error": "No upstream URL provided"}), 400

    upstream_url = upstream.rstrip("/") + "/v1/chat/completions"

    try:
        body = request.get_data()
        headers = {
            k: v
            for k, v in request.headers
            if k.lower() not in ("host", "content-length")
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


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=58000)
    args = parser.parse_args()
    print(f"Home Agent backend starting on port {args.port}", flush=True)
    app.run(host="0.0.0.0", port=args.port)

