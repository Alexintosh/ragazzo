#!/usr/bin/env python3
"""Private, provider-neutral OpenAI HTTP gateway; stdlib only, deliberately no logs.

Run: python3 -B /operator/model-gateway.py
Required: MODEL_BASE_URL (http[s] URL ending /v1), GATEWAY_TOKEN.
Optional: MODEL_ID (single allowed model), MODEL_API_KEY (upstream only),
PROMPT_CATALOG_PATH (trusted local Python with transform(body, language)),
PROMPT_LANGUAGE (en|zh, default zh), GATEWAY_HOST (default 0.0.0.0),
GATEWAY_PORT (default 8080). Catalog metadata is discarded, never logged.
"""
import copy
import hmac
import http.client
import importlib.util
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

MAX_REQUEST_BYTES = 2 * 1024 * 1024
MAX_RESPONSE_BYTES = 32 * 1024 * 1024
MAX_CONCURRENT = 16
CLIENT_TIMEOUT = 15
UPSTREAM_TIMEOUT = 60
UPSTREAM_TOTAL_TIMEOUT = 180
CHUNK_BYTES = 16 * 1024
ROUTES = frozenset(('/v1/chat/completions', '/v1/embeddings'))


class Config:
    def __init__(self, env=None):
        env = os.environ if env is None else env
        self.base = urlsplit(env.get('MODEL_BASE_URL', ''))
        if (self.base.scheme not in ('http', 'https') or not self.base.hostname
                or self.base.username is not None or self.base.password is not None
                or self.base.query or self.base.fragment
                or self.base.path.rstrip('/') != '/v1'):
            raise ValueError('invalid MODEL_BASE_URL')
        # Validate the port eagerly; never include configuration values in errors.
        self.base.port
        self.token = env.get('GATEWAY_TOKEN', '')
        self.api_key = env.get('MODEL_API_KEY', '')
        if not self.token or any(c in self.token + self.api_key for c in '\r\n'):
            raise ValueError('invalid credentials')
        self.model = env.get('MODEL_ID', '')
        self.language = env.get('PROMPT_LANGUAGE', 'zh')
        if self.language not in ('en', 'zh'):
            raise ValueError('invalid PROMPT_LANGUAGE')
        self.transform = None
        if env.get('PROMPT_CATALOG_PATH'):
            # Do not create a bytecode cache beside the read-only operator pack.
            sys.dont_write_bytecode = True
            spec = importlib.util.spec_from_file_location('operator_prompt_catalog', env['PROMPT_CATALOG_PATH'])
            if spec is None or spec.loader is None:
                raise ValueError('invalid PROMPT_CATALOG_PATH')
            catalog = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(catalog)
            self.transform = catalog.transform
            if not callable(self.transform):
                raise ValueError('invalid catalog transform')

    def prepare(self, body, route):
        if not isinstance(body, dict):
            raise ValueError('body must be an object')
        body = copy.deepcopy(body)
        if self.model:
            if body.get('model', self.model) != self.model:
                raise ValueError('model not allowed')
            body['model'] = self.model
        elif not isinstance(body.get('model'), str) or not body['model']:
            raise ValueError('model required')
        if 'stream' in body and not isinstance(body['stream'], bool):
            raise ValueError('stream must be boolean')
        if route == '/v1/chat/completions':
            if not isinstance(body.get('messages'), list) or not body['messages']:
                raise ValueError('messages required')
            if self.transform:
                body, _metadata = self.transform(body, self.language)
        elif 'input' not in body:
            raise ValueError('input required')
        return body

    def connect(self):
        cls = http.client.HTTPSConnection if self.base.scheme == 'https' else http.client.HTTPConnection
        return cls(self.base.hostname, self.base.port, timeout=UPSTREAM_TIMEOUT)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = MAX_CONCURRENT

    def __init__(self, address, config):
        self.config = config
        self.slots = threading.BoundedSemaphore(MAX_CONCURRENT)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b'HTTP/1.0 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Tracebacks can contain prompts, URLs or credentials.


class Handler(BaseHTTPRequestHandler):
    server_version = 'ModelGateway'
    sys_version = ''

    def setup(self):
        self.request.settimeout(CLIENT_TIMEOUT)
        super().setup()

    def log_message(self, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.reply(code, 'invalid request')

    def reply(self, status, message):
        data = json.dumps({'error': {'message': message}}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_GET(self):
        if self.path == '/health':
            data = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        else:
            self.reply(404, 'route not found')

    def do_POST(self):
        if self.path not in ROUTES:
            self.reply(404, 'route not found')
            return
        config = self.server.config
        auth = self.headers.get_all('Authorization', [])
        expected = ('Bearer ' + config.token).encode('utf-8')
        if len(auth) != 1 or not hmac.compare_digest(auth[0].encode('utf-8'), expected):
            self.reply(401, 'unauthorized')
            return
        lengths = self.headers.get_all('Content-Length', [])
        if self.headers.get_all('Transfer-Encoding') or len(lengths) != 1 or len(lengths[0]) > 20 or not lengths[0].isascii() or not lengths[0].isdigit():
            self.reply(400, 'content length required')
            return
        size = int(lengths[0])
        if size > MAX_REQUEST_BYTES:
            self.reply(413, 'request too large')
            return
        try:
            raw = bytearray()
            deadline = time.monotonic() + CLIENT_TIMEOUT
            while len(raw) < size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                self.connection.settimeout(remaining)
                chunk = self.rfile.read1(min(CHUNK_BYTES, size - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) != size:
                self.reply(400, 'incomplete request')
                return
            body = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
            body = config.prepare(body, self.path)
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode('utf-8')
            if len(data) > MAX_REQUEST_BYTES:
                self.reply(413, 'request too large')
                return
        except (socket.timeout, TimeoutError):
            self.reply(408, 'request timeout')
            return
        except (ValueError, TypeError, UnicodeError, RecursionError):
            self.reply(400, 'invalid request body')
            return
        except Exception:
            self.reply(500, 'prompt catalog unavailable')
            return
        self.forward(config, body, data)

    def forward(self, config, body, data):
        upstream = None
        started = False
        try:
            upstream = config.connect()
            headers = {'Content-Type': 'application/json', 'Accept': 'text/event-stream' if body.get('stream') else 'application/json'}
            if config.api_key:
                headers['Authorization'] = 'Bearer ' + config.api_key
            deadline = time.monotonic() + UPSTREAM_TOTAL_TIMEOUT
            upstream.request('POST', config.base.path.rstrip('/') + self.path[len('/v1'):], body=data, headers=headers)
            response = upstream.getresponse()
            # Redirects are never followed or exposed to clients with credentials.
            if 300 <= response.status < 400:
                self.reply(502, 'upstream redirect refused')
                return
            declared = response.getheader('Content-Length')
            if declared is not None and (not declared.isascii() or not declared.isdigit() or int(declared) > MAX_RESPONSE_BYTES):
                self.reply(502, 'invalid upstream response size')
                return
            streaming = bool(body.get('stream')) and response.status == 200
            if not streaming:
                payload = bytearray()
                while len(payload) <= MAX_RESPONSE_BYTES:
                    if time.monotonic() > deadline:
                        raise TimeoutError()
                    chunk = response.read1(min(CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - len(payload)))
                    if not chunk:
                        break
                    payload.extend(chunk)
                if len(payload) > MAX_RESPONSE_BYTES:
                    self.reply(502, 'upstream response too large')
                    return
            self.send_response(response.status)
            # Use a fixed content type; never propagate arbitrary provider headers.
            self.send_header('Content-Type', 'text/event-stream' if streaming else 'application/json')
            self.send_header('Connection', 'close')
            if not streaming:
                self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            started = True
            self.close_connection = True
            if streaming:
                total = 0
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError()
                    chunk = response.read1(min(CHUNK_BYTES, MAX_RESPONSE_BYTES + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_RESPONSE_BYTES:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            else:
                self.wfile.write(payload)
        except (OSError, http.client.HTTPException, ValueError):
            if not started:
                self.reply(502, 'upstream unavailable')
        finally:
            self.close_connection = True
            if upstream:
                upstream.close()


def main():
    try:
        config = Config()
        server = Server((os.environ.get('GATEWAY_HOST', '0.0.0.0'), int(os.environ.get('GATEWAY_PORT', '8080'))), config)
    except Exception:
        raise SystemExit('Gateway configuration failed') from None
    server.serve_forever()


if __name__ == '__main__':
    main()
