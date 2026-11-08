#!/usr/bin/env python
"""Local mock of the Firebase Realtime Database REST API (GET/PUT/PATCH/DELETE + SSE streaming).

Lets you test quarto-poll without a Firebase account. It also serves static files from --static,
so the rendered deck and audience/index.html can be opened from the same port.

  python dev/mock_firebase.py --port 8787 --static .
"""
import argparse
import json
import os
import queue
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DB = {}
LOCK = threading.Lock()
LISTENERS = []  # (parts, queue)


def get_at(parts):
    node = DB
    for p in parts:
        if isinstance(node, dict) and p in node:
            node = node[p]
        elif isinstance(node, list) and p.isdigit() and int(p) < len(node):
            node = node[int(p)]
        else:
            return None
    return node


def resolve_sv(data):
    """Replace Firebase server values such as {".sv": "timestamp"} like the real database does."""
    if isinstance(data, dict):
        if data.get(".sv") == "timestamp" and len(data) == 1:
            return int(time.time() * 1000)
        return {k: resolve_sv(v) for k, v in data.items()}
    if isinstance(data, list):
        return [resolve_sv(v) for v in data]
    return data


def set_at(parts, data):
    global DB
    data = resolve_sv(data)
    if not parts:
        DB = data if isinstance(data, dict) else {}
        return
    if not isinstance(DB, dict):
        DB = {}
    node = DB
    for p in parts[:-1]:
        if not isinstance(node.get(p), dict):
            node[p] = {}
        node = node[p]
    if data is None:
        node.pop(parts[-1], None)
    else:
        node[parts[-1]] = data


def patch_at(parts, data):
    if not isinstance(data, dict):
        return set_at(parts, data)
    for k, v in data.items():
        set_at(parts + [s for s in k.split("/") if s], v)


def notify():
    for parts, q in list(LISTENERS):
        q.put(("put", {"path": "/", "data": get_at(parts)}))


class Handler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        super().log_message(fmt, *args)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, PATCH, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Accept")
        super().end_headers()

    def parts(self):
        path = urlparse(self.path).path
        if not path.endswith(".json"):
            return None
        return [p for p in path[:-5].split("/") if p]

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b"null"
        return json.loads(raw or b"null")

    def reply(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        parts = self.parts()
        if parts is None:
            return super().do_GET()
        if "text/event-stream" in (self.headers.get("Accept") or ""):
            return self.stream(parts)
        with LOCK:
            self.reply(get_at(parts))

    def stream(self, parts):
        q = queue.Queue()
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        with LOCK:
            LISTENERS.append((parts, q))
            q.put(("put", {"path": "/", "data": get_at(parts)}))
        try:
            while True:
                try:
                    ev, payload = q.get(timeout=25)
                    msg = f"event: {ev}\ndata: {json.dumps(payload)}\n\n"
                except queue.Empty:
                    msg = "event: keep-alive\ndata: null\n\n"
                self.wfile.write(msg.encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with LOCK:
                LISTENERS[:] = [l for l in LISTENERS if l[1] is not q]

    def do_PUT(self):
        parts = self.parts()
        if parts is None:
            return self.reply({"error": "not a json path"}, 404)
        data = self.body()
        with LOCK:
            set_at(parts, data)
            notify()
        self.reply(data)

    def do_PATCH(self):
        parts = self.parts()
        if parts is None:
            return self.reply({"error": "not a json path"}, 404)
        data = self.body()
        with LOCK:
            patch_at(parts, data)
            notify()
        self.reply(data)

    def do_DELETE(self):
        parts = self.parts()
        if parts is None:
            return self.reply({"error": "not a json path"}, 404)
        with LOCK:
            set_at(parts, None)
            notify()
        self.reply(None)

    def do_POST(self):
        parts = self.parts()
        if parts is None:
            return self.reply({"error": "not a json path"}, 404)
        data = self.body()
        key = "-" + os.urandom(8).hex()
        with LOCK:
            set_at(parts + [key], data)
            notify()
        self.reply({"name": key})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--static", default=".")
    a = ap.parse_args()
    os.chdir(a.static)
    srv = ThreadingHTTPServer(("0.0.0.0", a.port), Handler)
    srv.daemon_threads = True
    print(f"Mock Firebase at http://localhost:{a.port}  (static files from {os.getcwd()})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
