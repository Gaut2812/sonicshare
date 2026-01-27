import asyncio
import websockets
import json
import base64

async def verify():
    uri = "ws://localhost:8000/ws"
    
    # 1. Sender: CREATE
    async with websockets.connect(uri) as ws_sender:
        await ws_sender.send(json.dumps({"action": "CREATE"}))
        resp_create = await ws_sender.recv()
        data_create = json.loads(resp_create)
        print(f"Sender received: {data_create}")
        
        if data_create.get("type") != "CODE":
            print(f"FAILED: Expected type 'CODE', got '{data_create.get('type')}'")
            return
        
        code = data_create.get("code")
        
        # 2. Receiver: JOIN
        async with websockets.connect(uri) as ws_receiver:
            await ws_receiver.send(json.dumps({"action": "JOIN", "code": code}))
            
            # Check READY in both
            resp_ready_sender = await ws_sender.recv()
            resp_ready_receiver = await ws_receiver.recv()
            
            data_ready_sender = json.loads(resp_ready_sender)
            data_ready_receiver = json.loads(resp_ready_receiver)
            
            print(f"Sender READY: {data_ready_sender}")
            print(f"Receiver READY: {data_ready_receiver}")
            
            if data_ready_sender.get("type") == "READY" and data_ready_receiver.get("type") == "READY":
                print("SUCCESS: CREATE -> JOIN -> READY works!")
            else:
                print("FAILED: Did not receive READY in both tabs.")
                return

            # 3. Data Transfer: HELLO_WORLD
            # Note: The relay method in session_manager currently relays data to ALL clients except sender
            test_payload = base64.b64encode(b"HELLO_WORLD").decode('utf-8')
            await ws_sender.send(json.dumps({
                "type": "DATA",
                "code": code,
                "seq": 0,
                "payload": test_payload
            }))
            
            resp_data = await ws_receiver.recv()
            data_recv = json.loads(resp_data)
            print(f"Receiver received data: {data_recv}")
            
            payload_decoded = base64.b64decode(data_recv.get("payload")).decode('utf-8')
            if payload_decoded == "HELLO_WORLD":
                print("SUCCESS: HELLO_WORLD transferred correctly!")
            else:
                print(f"FAILED: Transferred data mismatch. Got {payload_decoded}")

if __name__ == "__main__":
    asyncio.run(verify())
