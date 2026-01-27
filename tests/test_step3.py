import asyncio
import websockets
import json

async def test_session_flow():
    uri = "ws://localhost:8000/ws"
    
    # 1. Connect Sender
    async with websockets.connect(uri) as sender_ws:
        print("Sender connected")
        
        # 2. Create Session
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        response = await sender_ws.recv()
        data = json.loads(response)
        
        if data["type"] != "CREATED":
            print("FAILED: Session creation failed")
            return
            
        code = data["code"]
        print(f"Session created with code: {code}")
        
        # 3. Connect Receiver
        async with websockets.connect(uri) as receiver_ws:
            print("Receiver connected")
            
            # 4. Join Session
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            # Receiver should get READY
            recv_response = await receiver_ws.recv()
            recv_data = json.loads(recv_response)
            
            if recv_data["type"] == "READY":
                print("Receiver joined successfully")
            else:
                print(f"FAILED: Receiver got {recv_data}")
                
            # Sender should get peer_joined
            sender_response = await sender_ws.recv()
            sender_data = json.loads(sender_response)
            
            if sender_data["type"] == "peer_joined":
                print("Sender notified of peer join")
            else:
                 print(f"FAILED: Sender got {sender_data}")

if __name__ == "__main__":
    asyncio.run(test_session_flow())
