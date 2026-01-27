import asyncio
import websockets
import json
import base64
import os
import secrets

# Mock Crypto Helpers (Python side for testing)
# In reality, browser does WebCrypto. Here we just mock the payload structure 
# to ensure the server routes it and the protocol flow holds.
# We won't implement actual AES-GCM in python for this test unless needed,
# but we need to adhere to the IV:Ciphertext format if the server inspected it?
# Server is blind, so we can send dummy crypto payloads.
# BUT, if we want to verify correctness, we should ideally decrypt. 
# Since app.js expects WebCrypto, this Python test is simulating "Clients" 
# that speak the protocol.

async def test_full_file_transfer():
    uri = "ws://localhost:8000/ws"
    
    # Generate random 1MB file
    file_size = 1024 * 1024 # 1MB
    original_data = os.urandom(file_size)
    chunk_size = 64 * 1024
    
    print(f"Generated {file_size} bytes of random data")
    
    async with websockets.connect(uri) as sender_ws, websockets.connect(uri) as receiver_ws:
        
        # 1. SETUP SESSION
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        code = json.loads(await sender_ws.recv())["code"]
        print(f"Session Created: {code}")
        
        await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
        
        # Flush Ready
        await receiver_ws.recv() # READY
        await sender_ws.recv() # peer_joined
        
        # 2. KEY EXCHANGE (Mock)
        await sender_ws.send(json.dumps({"type": "KEY", "payload": "mock-key-sender"}))
        await receiver_ws.recv() # Receiver gets key
        
        await receiver_ws.send(json.dumps({"type": "KEY", "payload": "mock-key-receiver"}))
        await sender_ws.recv() # Sender gets key
        
        print("Key Exchange 'Mock' Complete")
        
        # 3. TRANSFER
        received_buffer = bytearray()
        offset = 0
        seq = 0
        file_name = "test_file.bin"
        
        # Receiver Loop Task
        async def receiver_loop():
            expected_seq = 0
            while True:
                msg = json.loads(await receiver_ws.recv())
                if msg["type"] == "START":
                    print(f"Receiver got START for: {msg['name']} ({msg['size']} bytes)")
                elif msg["type"] == "DATA":
                    if msg["seq"] == expected_seq:
                        # Extract "encrypted" payload
                        b64_data = msg["payload"] 
                        chunk = base64.b64decode(b64_data)
                        received_buffer.extend(chunk)
                        
                        # Send ACK
                        await receiver_ws.send(json.dumps({"type": "ACK", "seq": expected_seq}))
                        expected_seq += 1
                elif msg["type"] == "END":
                    print("Receiver got END")
                    break
        
        receiver_task = asyncio.create_task(receiver_loop())
        
        # Sender Loop
        await sender_ws.send(json.dumps({
            "type": "START",
            "name": file_name,
            "size": file_size
        }))

        while offset < file_size:
            chunk = original_data[offset : offset + chunk_size]
            
            await sender_ws.send(json.dumps({
                "type": "DATA",
                "seq": seq,
                "iv": "mock-iv",
                "payload": base64.b64encode(chunk).decode()
            }))
            
            # Wait for ACK
            ack = json.loads(await sender_ws.recv()) 
            if ack["type"] == "ACK" and ack["seq"] == seq:
                pass
            
            seq += 1
            offset += chunk_size
            if seq % 10 == 0:
                print(f"Sent chunk {seq-1}, Progress: {offset}/{file_size}")

        await sender_ws.send(json.dumps({"type": "END"}))
        await receiver_task
        
        # 4. VERIFY
        if original_data == received_buffer:
            print("SUCCESS: File transfer verified bit-for-bit!")
        else:
            print("FAILURE: Data mismatch")

if __name__ == "__main__":
    asyncio.run(test_full_file_transfer())
