import importlib.util
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

_spec = importlib.util.spec_from_file_location(
    "phison_sd_server_client", Path(__file__).resolve().parents[1] / "client.py"
)
client = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(client)

PNG = b"\x89PNG\r\n\x1a\nnot-a-real-image"


class _Server:
    """One-shot sd-server stand-in that records what it was sent."""

    def __init__(self, status, body, content_type):
        self.requests = []
        recorded = self.requests

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                recorded.append((self.path, json.loads(self.rfile.read(length))))
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.httpd = HTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class GenerateFileTest(unittest.TestCase):
    def test_posts_the_request_fields_and_returns_the_png(self):
        server = _Server(200, PNG, "image/png")
        try:
            png = client.generate_file(server.base_url, "a lion", 1344, 768, 9, 42)
        finally:
            server.close()
        self.assertEqual(png, PNG)
        self.assertEqual(
            server.requests,
            [
                (
                    "/generate/file",
                    {
                        "prompt": "a lion",
                        "width": 1344,
                        "height": 768,
                        "num_inference_steps": 9,
                        "seed": 42,
                    },
                )
            ],
        )

    def test_raises_with_the_server_sentence_on_failure(self):
        sentence = "generation failed; the server log has the details"
        body = json.dumps({"error": sentence}).encode("utf-8")
        server = _Server(500, body, "application/json")
        try:
            with self.assertRaises(RuntimeError) as caught:
                client.generate_file(server.base_url, "a lion", 1024, 1024, 9, 1)
        finally:
            server.close()
        self.assertIn(sentence, str(caught.exception))

    def test_refuses_a_non_http_base_url_before_sending(self):
        with self.assertRaises(RuntimeError):
            client.generate_file("file:///x", "a lion", 1024, 1024, 9, 1)


if __name__ == "__main__":
    unittest.main()
