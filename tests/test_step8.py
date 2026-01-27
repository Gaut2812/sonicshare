import asyncio
import websockets
import json

async def test_step8_key_exchange():
    uri = "ws://localhost:8000/ws"
    
    # 1. Connect Sender and Receiver
    async with websockets.connect(uri) as sender_ws:
        
        # Create
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        response = await sender_ws.recv()
        code = json.loads(response)["code"]
        print(f"Session: {code}")
        
        async with websockets.connect(uri) as receiver_ws:
            
            # Join
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            # Flush READY / peer_joined
            await receiver_ws.recv() # READY
            await sender_ws.recv() # peer_joined
            
            # Now, simulate Key Exchange Packets
            # Sender -> KEY_EXCHANGE
            print("Simulating Sender JWK...")
            mock_jwk_sender = {"kty":"EC","crv":"P-256","x":"mock_x","y":"mock_y"} # Minimal mock
            await sender_ws.send(json.dumps({
                "type": "KEY_EXCHANGE",
                "key": mock_jwk_sender
            }))
            
            # Receiver should get it
            recv_msg = json.loads(await receiver_ws.recv())
            if recv_msg["type"] == "KEY_EXCHANGE":
                print("Receiver got KEY_EXCHANGE. SUCCESS.")
            else:
                 print(f"Receiver failed to get key. Got: {recv_msg}")
                 
            # Receiver -> KEY_EXCHANGE
            print("Simulating Receiver JWK...")
            await receiver_ws.send(json.dumps({
                "type": "KEY_EXCHANGE",
                "key": mock_jwk_sender
            }))
            
            # Sender should get it
            sender_recv = json.loads(await sender_ws.recv())
            if sender_recv["type"] == "KEY_EXCHANGE":
                print("Sender got KEY_EXCHANGE. SUCCESS.")
            else:
                 print(f"Sender failed to get key. Got: {sender_recv}")


if __name__ == "__main__":
    asyncio.run(test_step8_key_exchange())
