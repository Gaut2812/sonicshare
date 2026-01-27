import asyncio
import websockets
import json

async def test():
    uri = "ws://localhost:8000/ws"
    try:
        async with websockets.connect(uri) as websocket:
            print("Connected to server")
            # Send a test message
            await websocket.send(json.dumps({"action": "PING"}))
            # Just close
            print("Test complete")
    except Exception as e:
        print(f"Connection failed: {e}")

if __name__ == "__main__":
    asyncio.run(test())
