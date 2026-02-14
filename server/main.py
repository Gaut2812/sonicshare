# main.py - Fixed FastAPI Backend
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
            # Remove sessions older than 10 minutes with no activity
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
            'created_at': datetime.now(),
            'last_activity': datetime.now(),
            'status': 'waiting'  # waiting, connecting, connected, completed
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

# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Simple health check for connection testing"""
    return {
        "status": "ok",
        "message": "SonicShare server is running",
        "active_sessions": len(session_manager.sessions)
    }

# REST API for initial signaling (more reliable than WebSocket for SDP exchange)
@app.post("/api/session")
async def create_session(data: dict):
    """Create a new transfer session"""
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
    return {
        "code": code,
        "status": "created",
        "message": "Share this code with receiver"
    }

@app.get("/api/session/{code}")
async def get_session(code: str):
    """Get session info (for receiver to get offer)"""
    session = session_manager.get_session(code)
    if not session:
        return {"error": "Session not found"}
    
    return {
        "code": code,
        "status": session['status'],
        "offer": session['offer'] if session['status'] == 'waiting' else None
    }

@app.post("/api/session/{code}/answer")
async def post_answer(code: str, data: dict):
    """Receiver posts their answer"""
    success = session_manager.set_answer(code, {
        'sdp': data.get('sdp'),
        'type': data.get('type')
    })
    
    if not success:
        return {"error": "Session not found"}
    
    print(f"[Session] Answer received for: {code}")
    
    # Notify sender via WebSocket if connected
    session = session_manager.get_session(code)
    if session and session.get('sender_ws'):
        try:
            await session['sender_ws'].send_json({
                'type': 'answer',
                'answer': session['answer']
            })
        except Exception as e:
            print(f"[Error] Failed to notify sender: {e}")
    
    return {"status": "ok", "message": "Answer received"}

@app.post("/api/session/{code}/ice")
async def add_ice_candidate(code: str, data: dict):
    """Add ICE candidate from either peer"""
    session = session_manager.get_session(code)
    if not session:
        return {"error": "Session not found"}
    
    candidate = data.get('candidate')
    role = data.get('role') # 'sender' or 'receiver'
    
    # Forward to other peer
    target_ws = session['receiver_ws'] if role == 'sender' else session['sender_ws']
    
    if target_ws:
        try:
            await target_ws.send_json({
                'type': 'ice_candidate',
                'candidate': candidate
            })
        except Exception as e:
            print(f"[Error] Failed to forward ICE: {e}")
    
    return {"status": "ok"}

# WebSocket for real-time updates (NOT for data transfer!)
@app.websocket("/ws/{code}/{role}")
async def websocket_endpoint(websocket: WebSocket, code: str, role: str):
    """
    WebSocket for signaling only - never transfer file data here!
    role: 'sender' or 'receiver'
    """
    await websocket.accept()
    
    session = session_manager.get_session(code)
    if not session:
        await websocket.send_json({"type": "error", "message": "Session not found"})
        await websocket.close()
        return
    
    # Store WebSocket reference
    if role == 'sender':
        session['sender_ws'] = websocket
    else:
        session['receiver_ws'] = websocket
    
    print(f"[WebSocket] {role} connected to session {code}")
    
    try:
        while True:
            # Use shorter timeout to prevent Windows asyncio issues
            try:
                data = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=30.0  # 30 second timeout
                )
            except asyncio.TimeoutError:
                # Send ping to keep alive
                await websocket.send_json({"type": "ping"})
                continue
            
            msg = json.loads(data)
            msg_type = msg.get('type')
            
            # Handle different message types
            if msg_type == 'ping':
                await websocket.send_json({"type": "pong"})
                
            elif msg_type == 'ice_candidate':
                # Forward ICE candidate to other peer
                other_role = 'receiver_ws' if role == 'sender' else 'sender_ws'
                other_ws = session.get(other_role)
                
                if other_ws:
                    await other_ws.send_json({
                        'type': 'ice_candidate',
                        'candidate': msg.get('candidate')
                    })
                    
            elif msg_type == 'transfer_ready':
                session['status'] = 'connected'
                # Notify other peer
                other_role = 'receiver_ws' if role == 'sender' else 'sender_ws'
                other_ws = session.get(other_role)
                if other_ws:
                    await other_ws.send_json({
                        'type': 'peer_ready',
                        'message': 'Ready to transfer'
                    })
                    
            elif msg_type == 'transfer_complete':
                session['status'] = 'completed'
                print(f"[Session] Transfer completed: {code}")
                
            elif msg_type == 'transfer_failed':
                session['status'] = 'failed'
                print(f"[Session] Transfer failed: {code}")
                
            # Update activity
            session['last_activity'] = datetime.now()
            
    except WebSocketDisconnect:
        print(f"[WebSocket] {role} disconnected from {code}")
    except Exception as e:
        print(f"[WebSocket] Error with {role} in {code}: {e}")
    finally:
        # Clear reference but keep session for reconnection
        if role == 'sender':
            session['sender_ws'] = None
        else:
            session['receiver_ws'] = None
        
        # If both disconnected and transfer not complete, mark failed
        if not session or (not session.get('sender_ws') and not session.get('receiver_ws')):
            if session and session['status'] not in ['completed', 'failed']:
                session['status'] = 'failed'
                print(f"[Session] Both peers disconnected, marking failed: {code}")

# Health check
@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "active_sessions": len(session_manager.sessions),
        "timestamp": datetime.now().isoformat()
    }

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"

# Handle favicon 404s
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return Response(status_code=204)

# Serve static files
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

# Serve HTML pages with no-cache headers
@app.get("/sender.html")
async def sender():
    response = FileResponse(WEB_DIR / "sender.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

@app.get("/receiver.html")
async def receiver():
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
    """Serve any other HTML files in the web directory"""
    file_path = WEB_DIR / f"{filename}.html"
    if file_path.exists():
        return FileResponse(file_path)
    return Response(status_code=404)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
