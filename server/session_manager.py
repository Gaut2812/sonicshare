import random

class Session:
    def __init__(self, code):
        self.code = code
        self.clients = []

class SessionManager:
    def __init__(self):
        self.sessions = {}

    def generate_code(self):
        return str(random.randint(100000, 999999))

    async def create(self, ws):
        code = self.generate_code()
        self.sessions[code] = Session(code)
        self.sessions[code].clients.append(ws)
        await ws.send_json({"type": "CODE", "code": code})
        print(f"Sent: {{'type': 'CODE', 'code': '{code}'}}")

    async def join(self, ws, code):
        session = self.sessions.get(code)

        if not session:
            await ws.send_json({"type": "ERROR", "msg": "INVALID_CODE"})
            return

        if len(session.clients) >= 2:
            await ws.send_json({"type": "ERROR", "msg": "SESSION_FULL"})
            return

        session.clients.append(ws)

        # 🔴 READY MUST BE SENT HERE
        if len(session.clients) == 2:
            for c in session.clients:
                await c.send_json({
                    "type": "READY",
                    "code": code
                })
            print(f"Sent: {{'type': 'READY', 'code': '{code}'}}")

    async def relay(self, ws, data):
        for session in self.sessions.values():
            if ws in session.clients:
                for c in session.clients:
                    if c != ws:
                        await c.send_json(data)

    def disconnect(self, ws):
        for code in list(self.sessions):
            if ws in self.sessions[code].clients:
                del self.sessions[code]
