import asyncio
import websockets
import json

async def test():
    uri = "ws://localhost:8000/ws"
    async with websockets.connect(uri) as websocket:
        await websocket.send(json.dumps({"action": "CREATE"}))
        response = await websocket.recv()
        print(f"RECEIVED: {response}")

if __name__ == "__main__":
    asyncio.run(test())
