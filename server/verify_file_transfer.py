import asyncio
import websockets
import json
import base64
import os

async def verify_file_transfer():
    uri = "ws://localhost:8000/ws"
    
    # Generate random 100KB file
    file_size = 100 * 1024 # 100KB
    original_data = os.urandom(file_size)
    chunk_size = 32 * 1024 # 32KB
    file_name = "test_transfer.bin"
    
    print(f"Starting test with {file_size} bytes and {chunk_size} byte chunks...")

    async with websockets.connect(uri) as sender_ws:
        # 1. Sender: CREATE
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        resp_create = await sender_ws.recv()
        data_create = json.loads(resp_create)
        code = data_create.get("code")
        print(f"Sender created session: {code}")

        async with websockets.connect(uri) as receiver_ws:
            # 2. Receiver: JOIN
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            # 3. VERIFY READY in both
            resp_ready_sender = await sender_ws.recv()
            resp_ready_receiver = await receiver_ws.recv()
            
            data_ready_sender = json.loads(resp_ready_sender)
            data_ready_receiver = json.loads(resp_ready_receiver)
            
            if data_ready_sender.get("type") == "READY" and data_ready_receiver.get("type") == "READY":
                print("[OK] READY received by both clients.")
            else:
                print(f"[FAILED] Unexpected READY response. Sender: {data_ready_sender}, Receiver: {data_ready_receiver}")
                return

            # 4. MOCK KEY EXCHANGE
            await sender_ws.send(json.dumps({"type": "KEY", "code": code, "payload": "sender-pub-key"}))
            await receiver_ws.recv() 
            
            await receiver_ws.send(json.dumps({"type": "KEY", "code": code, "payload": "receiver-pub-key"}))
            await sender_ws.recv() 
            print("[OK] Key exchange complete.")

            # 5. FILE TRANSFER
            received_buffer = bytearray()
            
            async def receiver_loop():
                expected_seq = 0
                while True:
                    msg = json.loads(await receiver_ws.recv())
                    if msg["type"] == "START":
                        print(f"Receiver: Recv START for {msg['name']}")
                    elif msg["type"] == "DATA":
                        if msg["seq"] == expected_seq:
                            chunk = base64.b64decode(msg["payload"])
                            received_buffer.extend(chunk)
                            await receiver_ws.send(json.dumps({"type": "ACK", "code": code, "seq": expected_seq}))
                            expected_seq += 1
                    elif msg["type"] == "END":
                        print("Receiver: Recv END")
                        break
            
            receiver_task = asyncio.create_task(receiver_loop())

            await sender_ws.send(json.dumps({
                "type": "START",
                "code": code,
                "name": file_name,
                "size": file_size
            }))

            offset = 0
            seq = 0
            while offset < file_size:
                chunk = original_data[offset : offset + chunk_size]
                await sender_ws.send(json.dumps({
                    "type": "DATA",
                    "code": code,
                    "seq": seq,
                    "iv": "test-iv",
                    "payload": base64.b64encode(chunk).decode()
                }))
                
                ack_resp = await sender_ws.recv()
                ack = json.loads(ack_resp)
                
                offset += chunk_size
                seq += 1
                if seq % 2 == 0:
                    print(f"Sender: Sent chunk {seq-1}, Progress: {offset}/{file_size}")

            await sender_ws.send(json.dumps({"type": "END", "code": code}))
            await receiver_task

            if original_data == received_buffer:
                print("[OK] SUCCESS: File transfer verified bit-for-bit!")
            else:
                print(f"[FAILED] Data mismatch. Sent {len(original_data)}, Recv {len(received_buffer)}")

if __name__ == "__main__":
    asyncio.run(verify_file_transfer())
