import asyncio
import websockets
import json

async def test_step7_resume_protocol():
    uri = "ws://localhost:8000/ws"
    
    # 1. Connect Sender
    async with websockets.connect(uri) as sender_ws:
        
        # Create
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        response = await sender_ws.recv()
        code = json.loads(response)["code"]
        print(f"Session: {code}")
        
        # 3. Connect Receiver (Simulate Resume)
        async with websockets.connect(uri) as receiver_ws:
            
            # Join
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            await receiver_ws.recv() # READY
            await sender_ws.recv() # peer_joined
            
            # Simulate Receiver sending RESUME
            print("Sending RESUME packet from Receiver...")
            resume_seq = 10
            await receiver_ws.send(json.dumps({
                "type": "RESUME",
                "lastSeq": resume_seq
            }))
            
            # Sender should receive RESUME
            resume_msg = json.loads(await sender_ws.recv())
            if resume_msg["type"] == "RESUME" and resume_msg["lastSeq"] == resume_seq:
                print(f"Sender got RESUME request for seq {resume_seq}. SUCCESS.")
            else:
                 print(f"Sender failed to get RESUME. Got: {resume_msg}")

if __name__ == "__main__":
    asyncio.run(test_step7_resume_protocol())
