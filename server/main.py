from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse
from session_manager import SessionManager
import os
from pathlib import Path

app = FastAPI()

# ✅ PART A & B: ENABLE CORS & HANDLE WEBSOCKET ORIGIN
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # allow all (DEV ONLY)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

manager = SessionManager()

# WebSocket endpoint
@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    origin = ws.headers.get("origin")
    print("WebSocket Origin:", origin)

    await ws.accept()
    print("Client connected")

    try:
        while True:
            data = await ws.receive_json()
            print("Received:", data)

            action = data.get("action")

            if action == "CREATE":
                await manager.create(ws)
            elif action == "JOIN":
                await manager.join(ws, data.get("code"))
            else:
                # Relay everything else (DATA, ACK, RESUME, KEY, HASH, START, etc.)
                await manager.relay(ws, data)

    except Exception as e:
        print("Client disconnected:", e)
        manager.disconnect(ws)

# Get absolute path to web directory
BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR.parent / "web"

print(f"Serving files from: {WEB_DIR}")

# Serve static files (CSS, JS, etc) - must come BEFORE the catch-all route
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

@app.get("/index.html")
async def index_html():
    response = FileResponse(WEB_DIR / "index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response

# Root route - serve index.html
@app.get("/")
async def index():
    response = FileResponse(WEB_DIR / "index.html")
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return response
