from fastapi import WebSocket
from server.session_manager import SessionManager

class PacketRouter:
    def __init__(self, session_manager: SessionManager):
        self.manager = session_manager

    async def route(self, websocket: WebSocket, message: dict):
        msg_type = message.get("type")
        
        # Allowed packet types for forwarding
        ALLOWED_TYPES = ["DATA", "ACK", "RESUME", "END", "ERROR", "KEY_EXCHANGE", "KEY", "START", "HASH"]
        
        if msg_type in ALLOWED_TYPES:
            session = self.manager.find_session_by_websocket(websocket)
            if session:
                target = session.receiver if websocket == session.sender else session.sender
                if target:
                    await target.send_json(message)
                    return True
        return False
