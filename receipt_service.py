"""Throwaway local service: record each POST, then lose its response."""
import http.server, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
receipts = root / 'receipts.json'
access = root / 'access.jsonl'
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def record(self):
        with access.open('a') as file: file.write(json.dumps({'method': self.command, 'path': self.path}) + '\n')
    def do_POST(self):
        self.record()
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        values = json.loads(receipts.read_text()) if receipts.exists() else []
        values.append({'sequence': len(values) + 1, 'body': body})
        receipts.write_text(json.dumps(values, indent=2) + '\n')
        self.close_connection = True
    def do_GET(self):
        self.record()
        body = receipts.read_bytes() if receipts.exists() else b'[]'
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
(root / 'service.json').write_text(json.dumps({'url': 'http://127.0.0.1:' + str(server.server_port) + '/receipts'}) + '\n')
print(server.server_port, flush=True)
server.serve_forever()
