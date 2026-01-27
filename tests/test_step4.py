import asyncio
import websockets
import json
import base64

async def test_step4_text_flow():
    uri = "ws://localhost:8000/ws"
    
    # 1. Connect Sender
    async with websockets.connect(uri) as sender_ws:
        
        # Create Session
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        response = await sender_ws.recv()
        code = json.loads(response)["code"]
        print(f"Session: {code}")
        
        # 3. Connect Receiver
        async with websockets.connect(uri) as receiver_ws:
            
            # Join Session
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            # Flush ready messages
            await receiver_ws.recv() # READY
            sender_msg = await sender_ws.recv() # peer_joined
            
            # --- STEP 4 TEST ---
            print("Testing Text Send...")
            msg = "HELLO_FROM_SENDER"
            payload = base64.b64encode(msg.encode()).decode()
            
            await sender_ws.send(json.dumps({
                "type": "DATA",
                "seq": 0,
                "payload": payload
            }))
            
            # Receiver should get it
            recv_response = await receiver_ws.recv()
            data = json.loads(recv_response)
            
            if data["type"] == "DATA":
                decoded = base64.b64decode(data["payload"]).decode()
                if decoded == msg:
                    print(f"SUCCESS: Receiver got '{decoded}'")
                else:
                    print(f"FAIL: Content mismatch. Got '{decoded}'")
            else:
                print(f"FAIL: Expected DATA, got {data['type']}")

if __name__ == "__main__":
    asyncio.run(test_step4_text_flow())
