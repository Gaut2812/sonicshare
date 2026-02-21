# main.py - Fixed FastAPI Backend (Reliable Pairing)
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
import json
import asyncio
import uuid
from typing import Dict, Optional
from datetime import datetime, timedelta
from pathlib import Path
import os
import random

app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Session storage with automatic cleanup
class SessionManager:
    def __init__(self):
        self.sessions: Dict[str, dict] = {}
        self.cleanup_task = None
    
    async def start_cleanup(self):
        while True:
            await asyncio.sleep(60)  # Every minute
            self._cleanup_stale_sessions()
    
    def _cleanup_stale_sessions(self):
        now = datetime.now()
        stale = []
        for code, session in self.sessions.items():
            if now - session.get('last_activity', now) > timedelta(minutes=10):
                stale.append(code)
        for code in stale:
            del self.sessions[code]
            print(f"[Cleanup] Removed stale session: {code}")
    
    def create_session(self, code: str, offer: dict) -> dict:
        self.sessions[code] = {
            'code': code,
            'offer': offer,
            'answer': None,
            'sender_ws': None,
            'receiver_ws': None,
            # Unified ICE buffer: keyed by recipient role
            # sender_ice = candidates FROM sender, TO be delivered TO receiver
            # receiver_ice = candidates FROM receiver, TO be delivered TO sender
            'sender_ice': [],
            'receiver_ice': [],
            # Pending signals queued when WS was not yet connected
            'pending_for_sender': [],   # messages queued for sender
            'pending_for_receiver': [], # messages queued for receiver
            'created_at': datetime.now(),
            'last_activity': datetime.now(),
            'status': 'waiting'
        }
        return self.sessions[code]
    
    def get_session(self, code: str) -> Optional[dict]:
        session = self.sessions.get(code)
        if session:
            session['last_activity'] = datetime.now()
        return session
    
    def set_answer(self, code: str, answer: dict) -> bool:
        session = self.get_session(code)
        if session:
            session['answer'] = answer
            session['status'] = 'connecting'
            return True
        return False

session_manager = SessionManager()

@app.on_event("startup")
async def startup():
    asyncio.create_task(session_manager.start_cleanup())

# ---------------------------------------------------------------------------
# REST API — Reliable SDP + ICE handshake
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health_check():
    return {
        "status": "ok",
        "message": "SonicShare server is running",
        "active_sessions": len(session_manager.sessions)
    }

@app.post("/api/session")
async def create_session(data: dict):
    code = data.get('code')
    if not code:
        code = "".join([str(random.randint(0, 9)) for _ in range(6)])
    if len(code) != 6:
        return {"error": "Invalid code format"}
    
    session = session_manager.create_session(code, {
        'sdp': data.get('sdp'),
        'type': data.get('type'),
        'ice_candidates': []
    })
    print(f"[Session] Created: {code}")
    return {"code": code, "status": "created"}

@app.get("/api/session/{code}")
async def get_session(code: str):
    session = session_manager.get_session(code)
    if not session:
        return {"error": "Session not found"}
    return {
        "code": code,
        "status": session['status'],
        "offer": session['offer'],
        "answer": session.get('answer'),
    }

@app.post("/api/session/{code}/answer")
async def post_answer(code: str, data: dict):
    """
    Receiver posts SDP answer via REST.
    We store it and notify the sender.
    If the sender WS is already connected → push immediately.
    If not → queue it in pending_for_sender to be flushed when they connect.
    """
    success = session_manager.set_answer(code, {
        'sdp': data.get('sdp'),
        'type': data.get('type')
    })
    if not success:
        return {"error": "Session not found"}
    
    print(f"[Session] Answer received for: {code}")
    
    session = session_manager.get_session(code)
    answer_msg = {'type': 'answer', 'answer': session['answer']}
    
    sender_ws = session.get('sender_ws')
    if sender_ws:
        try:
            await sender_ws.send_json(answer_msg)
            print(f"[Session] Answer pushed to sender WS: {code}")
        except Exception as e:
            print(f"[Error] Failed to push answer to sender: {e}")
            session['pending_for_sender'].append(answer_msg)
    else:
        # Sender WS not yet connected — queue for flush on WS connect
        session['pending_for_sender'].append(answer_msg)
        print(f"[Session] Sender WS not ready, queued answer for: {code}")
    
    return {"status": "ok"}

@app.post("/api/session/{code}/ice")
async def add_ice_candidate(code: str, data: dict):
    """
    Add ICE candidate via REST fallback (used when WS is not yet open).
    Always buffers the candidate in the correct queue, then attempts delivery.
    """
    session = session_manager.get_session(code)
    if not session:
        return {"error": "Session not found"}
    
    candidate = data.get('candidate')
    role = data.get('role')  # 'sender' or 'receiver'
    
    # FROM sender → deliver TO receiver
    if role == 'sender':
        target_ws = session.get('receiver_ws')
        buffer_key = 'sender_ice'
    else:  # FROM receiver → deliver TO sender
        target_ws = session.get('sender_ws')
        buffer_key = 'receiver_ice'
    
    ice_msg = {'type': 'ice_candidate', 'candidate': candidate}
    
    if target_ws:
        try:
            await target_ws.send_json(ice_msg)
        except Exception as e:
            print(f"[Error] Failed to forward ICE: {e}")
            session[buffer_key].append(candidate)
    else:
        session[buffer_key].append(candidate)
        print(f"[ICE] REST-buffered candidate from {role} (total: {len(session[buffer_key])})")
    
    return {"status": "ok"}

# ---------------------------------------------------------------------------
# WebSocket — real-time updates (ICE, status, keepalive)
# ---------------------------------------------------------------------------

async def _flush_pending(websocket: WebSocket, pending: list, label: str):
    """Deliver any queued messages to a peer that just connected."""
    if not pending:
        return
    print(f"[Flush] Sending {len(pending)} queued messages to {label}")
    for msg in list(pending):
        try:
            await websocket.send_json(msg)
        except Exception as e:
            print(f"[Flush] Error: {e}")
    pending.clear()

async def _flush_ice(websocket: WebSocket, ice_buffer: list, label: str):
    """Deliver buffered ICE candidates to a peer that just connected."""
    if not ice_buffer:
        return
    print(f"[ICE] Flushing {len(ice_buffer)} buffered candidates to {label}")
    for candidate in list(ice_buffer):
        try:
            await websocket.send_json({'type': 'ice_candidate', 'candidate': candidate})
        except Exception as e:
            print(f"[ICE] Flush error: {e}")
    ice_buffer.clear()

@app.websocket("/ws/{code}/{role}")
async def websocket_endpoint(websocket: WebSocket, code: str, role: str):
    await websocket.accept()
    
    session = session_manager.get_session(code)
    if not session:
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return
    
    # Register this peer's WebSocket
    if role == 'sender':
        session['sender_ws'] = websocket
        # Flush any answer / ICE that arrived from receiver before sender WS was open
        await _flush_pending(websocket, session['pending_for_sender'], 'sender')
        await _flush_ice(websocket, session['receiver_ice'], 'sender')
    else:
        session['receiver_ws'] = websocket
        # Flush any ICE that arrived from sender before receiver WS was open
        await _flush_ice(websocket, session['sender_ice'], 'receiver')
        # Also flush any pending messages for receiver
        await _flush_pending(websocket, session['pending_for_receiver'], 'receiver')
    
    print(f"[WebSocket] {role} connected to session {code}")
    
    try:
        while True:
            try:
                data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=30.0
                )
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
                continue
            
            msg = json.loads(data)
            msg_type = msg.get('type')
            session['last_activity'] = datetime.now()
            
            if msg_type == 'ping':
                await websocket.send_json({"type": "pong"})
            
            elif msg_type == 'pong':
                pass  # keepalive acknowledged
            
            elif msg_type == 'ice_candidate':
                # FROM this role → forward TO the other peer
                if role == 'sender':
                    target_ws = session.get('receiver_ws')
                    buffer = session['sender_ice']
                else:
                    target_ws = session.get('sender_ws')
                    buffer = session['receiver_ice']
                
                ice_msg = {'type': 'ice_candidate', 'candidate': msg.get('candidate')}
                if target_ws:
                    try:
                        await target_ws.send_json(ice_msg)
                    except Exception:
                        buffer.append(msg.get('candidate'))
                else:
                    buffer.append(msg.get('candidate'))
                    print(f"[ICE] WS-buffered from {role} (total: {len(buffer)})")
            
            elif msg_type == 'transfer_ready':
                session['status'] = 'connected'
                # Notify the other peer; if not connected, queue it
                if role == 'sender':
                    target_ws = session.get('receiver_ws')
                    queue = session['pending_for_receiver']
                else:
                    target_ws = session.get('sender_ws')
                    queue = session['pending_for_sender']
                
                ready_msg = {'type': 'peer_ready', 'message': 'Ready to transfer'}
                if target_ws:
                    try:
                        await target_ws.send_json(ready_msg)
                    except Exception:
                        queue.append(ready_msg)
                else:
                    queue.append(ready_msg)
                    print(f"[Ready] Other peer not connected yet, queued for {code}")
            
            elif msg_type == 'transfer_complete':
                session['status'] = 'completed'
                print(f"[Session] Transfer completed: {code}")
            
            elif msg_type == 'transfer_failed':
                session['status'] = 'failed'
                print(f"[Session] Transfer failed: {code}")
                    
    except WebSocketDisconnect:
        print(f"[WebSocket] {role} disconnected from {code}")
    except Exception as e:
        print(f"[WebSocket] Error with {role} in {code}: {e}")
    finally:
        if role == 'sender':
            session['sender_ws'] = None
        else:
            session['receiver_ws'] = None
        
        if session and not session.get('sender_ws') and not session.get('receiver_ws'):
            if session['status'] not in ['completed', 'failed']:
                session['status'] = 'failed'
                print(f"[Session] Both peers disconnected: {code}")

# ---------------------------------------------------------------------------
# Static file serving
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)

app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

@app.get("/sender.html")
async def sender():
    response = FileResponse(WEB_DIR / "sender.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/receiver.html")
async def receiver_page():
    response = FileResponse(WEB_DIR / "receiver.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/")
@app.get("/index.html")
async def index():
    response = FileResponse(WEB_DIR / "index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/{filename}.html")
async def serve_generic_html(filename: str):
    file_path = WEB_DIR / f"{filename}.html"
    if file_path.exists():
        return FileResponse(file_path)
    return Response(status_code=404)

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
