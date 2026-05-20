#!/usr/bin/env python3
import http.server, socketserver

PORT = 3000
DIR  = "/Users/lucie/Documents/Claude/simulateur-renewal"

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kw):
        super().__init__(*args, directory=DIR, **kw)
    def log_message(self, *a): pass

with socketserver.TCPServer(("", PORT), H) as s:
    s.serve_forever()
