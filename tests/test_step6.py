import asyncio
import websockets
import json
import base64

async def test_step6_reliability():
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
            await sender_ws.recv() # peer_joined
            
            print("Testing Reliable Transfer (Mock)...")
            
            # Simulate Sender sending Chunk 0
            msg_payload = base64.b64encode(b"DATA_CHUNK_0").decode()
            await sender_ws.send(json.dumps({
                "type": "DATA",
                "seq": 0,
                "payload": msg_payload
            }))
            
            # Receiver verifies and ACKs
            recv_msg = json.loads(await receiver_ws.recv())
            if recv_msg["type"] == "DATA" and recv_msg["seq"] == 0:
                print("Receiver got chunk 0. Sending ACK...")
                await receiver_ws.send(json.dumps({
                    "type": "ACK",
                    "seq": 0
                }))
            else:
                print(f"Receiver failed to get chunk 0. Got: {recv_msg}")
                return

            # Sender receives ACK
            ack_msg = json.loads(await sender_ws.recv())
            if ack_msg["type"] == "ACK" and ack_msg["seq"] == 0:
                print("Sender received ACK 0. SUCCESS.")
            else:
                 print(f"Sender failed to get ACK. Got: {ack_msg}")


if __name__ == "__main__":
    asyncio.run(test_step6_reliability())
