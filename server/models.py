from typing import Optional
from fastapi import WebSocket

class Session:
    def __init__(self, code: str, sender: WebSocket):
        self.code = code
        self.sender = sender
        self.receiver: Optional[WebSocket] = None
