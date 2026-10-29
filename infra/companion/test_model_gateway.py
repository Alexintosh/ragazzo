"""Offline gateway contracts: fake sockets/connections; no network or provider calls.

Run: python3 -B -m unittest discover -s infra/companion -p 'test_model_gateway.py'
"""
import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('model_gateway', HERE / 'model-gateway.py')
gateway = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gateway)


class Socket:
    def __init__(self, request):
        self.input = io.BytesIO(request)
        self.output = bytearray()

    def settimeout(self, value):
        pass

    def makefile(self, mode, *args):
        return self.input

    def sendall(self, data):
        self.output.extend(data)


class Response(io.BytesIO):
    def __init__(self, body=b'{"ok":true}', status=200, headers=None):
        super().__init__(body)
        self.status = status
        self.headers = headers or {}

    def getheader(self, key, default=None):
        return self.headers.get(key, default)


class Connection:
    def __init__(self, response):
        self.response = response
        self.requests = []
        self.closed = False

    def request(self, *args, **kwargs):
        self.requests.append((args, kwargs))

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class GatewayTests(unittest.TestCase):
    def config(self, **overrides):
        return gateway.Config(dict(MODEL_BASE_URL='http://provider.invalid:1234/v1',
                                   GATEWAY_TOKEN='private-client-token', MODEL_ID='test-model', **overrides))

    def request(self, config=None, body=None, headers=None, route='/v1/chat/completions',
                response=None, raw=None, method='POST'):
        config = config or self.config()
        data = json.dumps(body if body is not None else {'messages': [{'role': 'user', 'content': 'private prompt'}]}).encode()
        headers = headers if headers is not None else [('Authorization', 'Bearer private-client-token')]
        request = (f'{method} {route} HTTP/1.1\r\n' + ''.join(f'{k}: {v}\r\n' for k, v in headers)
                   + f'Content-Length: {len(data)}\r\n\r\n').encode() + data
        sock = Socket(raw if raw is not None else request)
        connection = Connection(response if response is not None else Response())
        with patch.object(config, 'connect', return_value=connection), patch('sys.stderr', new_callable=io.StringIO) as logs:
            gateway.Handler(sock, ('127.0.0.1', 1), types.SimpleNamespace(config=config))
            self.assertEqual(logs.getvalue(), '')
        return bytes(sock.output), connection

    def test_authentication_and_duplicate_headers(self):
        for headers in ([], [('Authorization', 'Bearer wrong')],
                        [('Authorization', 'Bearer private-client-token')] * 2):
            output, connection = self.request(headers=headers)
            self.assertIn(b'401 Unauthorized', output)
            self.assertEqual(connection.requests, [])

    def test_header_isolation_and_fixed_destination(self):
        output, conn = self.request(config=self.config(MODEL_API_KEY='upstream-secret'), headers=[
            ('Authorization', 'Bearer private-client-token'), ('X-Api-Key', 'untrusted'),
            ('Host', 'evil.invalid'), ('Cookie', 'sensitive')],
            response=Response(headers={'Set-Cookie': 'secret', 'Location': 'http://evil.invalid', 'X-Api-Key': 'secret'}))
        args, kwargs = conn.requests[0]
        self.assertEqual(args, ('POST', '/v1/chat/completions'))
        self.assertEqual(kwargs['headers'], {'Content-Type': 'application/json', 'Accept': 'application/json',
                                            'Authorization': 'Bearer upstream-secret'})
        self.assertNotIn(b'private-client-token', output)
        self.assertNotIn(b'Set-Cookie', output)
        self.assertNotIn(b'Location', output)
        self.assertTrue(conn.closed)
        _, conn = self.request()
        self.assertNotIn('Authorization', conn.requests[0][1]['headers'])

    def test_direct_connection_ignores_proxy_environment(self):
        with patch.dict('os.environ', {'HTTP_PROXY': 'http://evil.invalid', 'HTTPS_PROXY': 'http://evil.invalid'}), \
                patch.object(gateway.http.client, 'HTTPConnection') as constructor:
            self.config().connect()
        constructor.assert_called_once_with('provider.invalid', 1234, timeout=gateway.UPSTREAM_TIMEOUT)

    def test_redirects_rejected_without_second_request(self):
        for code in (301, 302, 303, 307, 308):
            output, conn = self.request(response=Response(status=code, headers={'Location': 'http://evil.invalid/'}))
            self.assertIn(b'502 Bad Gateway', output)
            self.assertEqual(len(conn.requests), 1)
            self.assertNotIn(b'evil.invalid', output)

    def test_bounded_request_and_response(self):
        with patch.object(gateway, 'MAX_REQUEST_BYTES', 8):
            output, conn = self.request()
            self.assertIn(b'HTTP/1.0 413 ', output)
            self.assertFalse(conn.requests)
        for headers in ({}, {'Content-Length': '99'}, {'Content-Length': 'invalid'}):
            with patch.object(gateway, 'MAX_RESPONSE_BYTES', 8):
                output, conn = self.request(response=Response(b'x' * 99, headers=headers))
            self.assertIn(b'502 Bad Gateway', output)
            self.assertNotIn(b'x' * 9, output)

    def test_streaming_forwarding_and_cap(self):
        payload = b'data: {"ok":true}\n\ndata: [DONE]\n\n'
        body = {'messages': [{'role': 'user', 'content': 'private'}], 'stream': True}
        output, conn = self.request(body=body, response=Response(payload))
        self.assertTrue(output.endswith(payload))
        self.assertIn(b'text/event-stream', output)
        self.assertEqual(conn.requests[0][1]['headers']['Accept'], 'text/event-stream')
        with patch.object(gateway, 'MAX_RESPONSE_BYTES', 8), patch.object(gateway, 'CHUNK_BYTES', 4):
            output, _ = self.request(body=body, response=Response(b'x' * 99))
        self.assertEqual(len(output.split(b'\r\n\r\n', 1)[1]), 8)

    def test_invalid_inputs_are_sanitized(self):
        for body in ([], {}, {'model': 'other', 'messages': []}, {'messages': [], 'stream': 'yes'}):
            output, conn = self.request(body=body)
            self.assertIn(b'400 Bad Request', output)
            self.assertFalse(conn.requests)
        for tail in (b'Content-Length: -1\r\n\r\n', b'Transfer-Encoding: chunked\r\n\r\n',
                     b'Content-Length: 1\r\nContent-Length: 1\r\n\r\n{}',
                     b'Content-Length: 4\r\n\r\nnull', b'Content-Length: 3\r\n\r\nNaN'):
            raw = b'POST /v1/chat/completions HTTP/1.1\r\nAuthorization: Bearer private-client-token\r\n' + tail
            output, conn = self.request(raw=raw)
            self.assertIn(b'400 Bad Request', output)
            self.assertFalse(conn.requests)
        output, conn = self.request(route='/v1/chat/completions?url=http://evil.invalid')
        self.assertIn(b'404 Not Found', output)
        self.assertFalse(conn.requests)

    def test_upstream_failure_is_sanitized(self):
        response = Response()
        with patch.object(response, 'read1', side_effect=TimeoutError('private upstream detail')):
            output, conn = self.request(response=response)
        self.assertIn(b'502 Bad Gateway', output)
        self.assertNotIn(b'private upstream detail', output)
        self.assertTrue(conn.closed)

    def test_concurrency_rejection_does_not_spawn_thread(self):
        server = gateway.Server.__new__(gateway.Server)
        server.slots = gateway.threading.BoundedSemaphore(1)
        server.slots.acquire()
        sock = Socket(b'')
        with patch.object(server, 'shutdown_request') as shutdown:
            server.process_request(sock, ('127.0.0.1', 1))
        self.assertIn(b'503 Service Unavailable', sock.output)
        shutdown.assert_called_once_with(sock)

    def test_health_and_embeddings(self):
        output, conn = self.request(route='/health', method='GET', headers=[])
        self.assertIn(b'200 OK', output)
        self.assertFalse(conn.requests)
        output, conn = self.request(route='/v1/embeddings', body={'input': ['private'], 'dimensions': 32})
        self.assertIn(b'200 OK', output)
        self.assertEqual(json.loads(conn.requests[0][1]['body'])['dimensions'], 32)

    def test_configuration_validation(self):
        for url in ('https://provider.invalid/other', 'https://user:pass@provider.invalid/v1',
                    'file:///v1', 'https://provider.invalid/v1?redirect=other'):
            with self.assertRaises(ValueError):
                gateway.Config({'MODEL_BASE_URL': url, 'GATEWAY_TOKEN': 'token'})
        with self.assertRaises(ValueError):
            self.config(PROMPT_LANGUAGE='xx')

    def test_catalog_contract_preserves_fields_and_discards_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            catalog = Path(directory) / 'catalog.py'
            catalog.write_text('import copy\ndef transform(body, language):\n'
                               ' result = copy.deepcopy(body)\n'
                               ' result["messages"][0]["content"] = language\n'
                               ' return result, {"private_metadata": "never forward"}\n')
            config = self.config(PROMPT_CATALOG_PATH=str(catalog), PROMPT_LANGUAGE='en')
            body = {'messages': [{'role': 'system', 'content': 'original'}, {'role': 'user', 'content': 'keep'}],
                    'temperature': 0.3, 'response_format': {'type': 'json_object'}, 'custom': [1]}
            saved = copy.deepcopy(body)
            _, conn = self.request(config=config, body=body)
            sent = json.loads(conn.requests[0][1]['body'])
            self.assertEqual(body, saved)
            self.assertEqual(sent['messages'][1:], body['messages'][1:])
            self.assertEqual(sent['messages'][0]['content'], 'en')
            self.assertNotIn('private_metadata', sent)
            for key in ('temperature', 'response_format', 'custom'):
                self.assertEqual(sent[key], body[key])
            self.assertFalse((Path(directory) / '__pycache__').exists())

    def test_existing_english_pack_preservation_when_available(self):
        catalog = HERE.parent.parent / '.cache/eros-evaluation/trial/english_prompts.py'
        if not catalog.exists():
            self.skipTest('operator-owned pinned English catalog is not installed')
        config = self.config(PROMPT_CATALOG_PATH=str(catalog), PROMPT_LANGUAGE='en')
        spec = importlib.util.spec_from_file_location('test_operator_catalog', catalog)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        body = {'messages': [{'role': 'system', 'content': module.EVAL_ZH},
                             {'role': 'user', 'content': 'Opaque authored story 中文原样保留'}],
                'temperature': 0.3, 'response_format': {'type': 'json_object'}, 'stream': True}
        saved = copy.deepcopy(body)
        _, conn = self.request(config=config, body=body)
        sent = json.loads(conn.requests[0][1]['body'])
        self.assertEqual(sent['messages'][0]['content'], module.EVAL_EN)
        self.assertEqual(sent['messages'][1:], body['messages'][1:])
        for key in ('temperature', 'response_format', 'stream'):
            self.assertEqual(sent[key], body[key])
        self.assertEqual(body, saved)
        config.language = 'zh'
        self.assertEqual(config.prepare(body, '/v1/chat/completions'), dict(body, model='test-model'))


if __name__ == '__main__':
    unittest.main()
