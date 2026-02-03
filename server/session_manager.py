import random
import time
import asyncio

class Session:
    def __init__(self, code):
        self.code = code
        self.clients = []
        self.last_activity = time.time()

    def touch(self):
        self.last_activity = time.time()

class SessionManager:
    def __init__(self):
        self.sessions = {}
        self.client_map = {} # ws -> code
        self._prune_task = None

    def start_cleanup_task(self):
        if self._prune_task is None:
            self._prune_task = asyncio.create_task(self._periodic_prune())

    async def _periodic_prune(self):
        while True:
            await asyncio.sleep(60) # Only check once a minute to save CPU
            now = time.time()
            timeout = 10 * 60 # 10 minutes
            
            idle_codes = [
                code for code, session in self.sessions.items()
                if now - session.last_activity > timeout
            ]
            
            for code in idle_codes:
                print(f"⏰ Session {code} timed out due to inactivity (10m)")
                self._delete_session(code)

    def _delete_session(self, code):
        if code in self.sessions:
            session = self.sessions[code]
            for ws in session.clients:
                if ws in self.client_map:
                    del self.client_map[ws]
            del self.sessions[code]

    def generate_code(self):
        return str(random.randint(100000, 999999))

    async def create(self, ws):
        self.start_cleanup_task()
        code = self.generate_code()
        self.sessions[code] = Session(code)
        self.sessions[code].clients.append(ws)
        self.client_map[ws] = code
        await ws.send_json({"type": "CODE", "code": code})
        print(f"Session Created: {code}")

    async def join(self, ws, code):
        print(f"Attempting to join session: '{code}'")
        session = self.sessions.get(code)

        if not session:
            print(f"❌ JOIN FAILED: Code '{code}' not found.")
            await ws.send_json({"type": "ERROR", "msg": "INVALID_CODE"})
            return

        if len(session.clients) >= 2:
            await ws.send_json({"type": "ERROR", "msg": "SESSION_FULL"})
            return

        session.clients.append(ws)
        self.client_map[ws] = code
        session.touch()

        if len(session.clients) == 2:
            for c in session.clients:
                await c.send_json({
                    "type": "READY",
                    "code": code
                })
            print(f"Session {code} is READY")

    async def relay(self, ws, data):
        code = self.client_map.get(ws)
        if not code:
            return

        session = self.sessions.get(code)
        if not session:
            return

        session.touch()
        msg_type = data.get("type", "UNKNOWN")
        
        # Throttled logging for data transfer
        if msg_type != "DATA" or data.get("seq", 0) % 500 == 0:
            print(f"[{code}] Relaying {msg_type}" + (f" seq:{data.get('seq')}" if 'seq' in data else ""))

        for c in session.clients:
            if c != ws:
                await c.send_json(data)

    async def relay_binary(self, ws, data):
        code = self.client_map.get(ws)
        if not code:
            return

        session = self.sessions.get(code)
        if not session:
            return

        session.touch()
        for c in session.clients:
            if c != ws:
                await c.send_bytes(data)

    def disconnect(self, ws):
        code = self.client_map.get(ws)
        if code:
            print(f"Cleanup: Removing session {code} due to disconnect")
            self._delete_session(code)
