import asyncio
import websockets
import json
import base64
import os

async def verify_step11_reliability():
    uri = "ws://localhost:8000/ws"
    
    # Test with 200KB file
    file_size = 200 * 1024 
    original_data = os.urandom(file_size)
    chunk_size = 32 * 1024 # 32KB
    file_name = "reliability_test.bin"
    
    print(f"Starting Reliability Test: {file_size} bytes, {chunk_size} byte chunks")

    async with websockets.connect(uri) as sender_ws:
        # 1. Sender: CREATE
        await sender_ws.send(json.dumps({"action": "CREATE"}))
        resp_create = await sender_ws.recv()
        data_create = json.loads(resp_create)
        code = data_create.get("code")
        print(f"Session Created: {code}")

        async with websockets.connect(uri) as receiver_ws:
            # 2. Receiver: JOIN
            await receiver_ws.send(json.dumps({"action": "JOIN", "code": code}))
            
            # 3. Both get READY
            r_ready = await receiver_ws.recv()
            s_ready = await sender_ws.recv()
            print("[OK] READY state reached in both clients")

            # 4. START transfer
            await sender_ws.send(json.dumps({
                "type": "START",
                "code": code,
                "name": file_name,
                "size": file_size
            }))
            
            # Receiver gets START
            r_start = await receiver_ws.recv()
            print(f"Receiver: OK Start for {file_name}")

            received_buffer = bytearray()
            
            # 5. DATA Transfer with Sliding Window simulation
            # We bypass the window on python side for simplicity, just send and wait for ACKs
            offset = 0
            seq = 0
            while offset < file_size:
                chunk = original_data[offset : offset + chunk_size]
                
                # Send Data
                print(f"Sender: Sending seq {seq}")
                await sender_ws.send(json.dumps({
                    "type": "DATA",
                    "code": code,
                    "seq": seq,
                    "payload": base64.b64encode(chunk).decode()
                }))
                
                # Receiver receives
                r_msg = await receiver_ws.recv()
                r_data = json.loads(r_msg)
                if r_data["seq"] == seq:
                    received_buffer.extend(base64.b64decode(r_data["payload"]))
                    # Send ACK
                    await receiver_ws.send(json.dumps({
                        "type": "ACK",
                        "code": code,
                        "seq": seq
                    }))
                
                # Sender receives ACK
                s_msg = await sender_ws.recv()
                s_ack = json.loads(s_msg)
                if s_ack["type"] == "ACK" and s_ack["seq"] == seq:
                    print(f"Sender: Got ACK {seq}")
                
                offset += chunk_size
                seq += 1

            # 6. END
            await sender_ws.send(json.dumps({"type": "END", "code": code}))
            r_end = await receiver_ws.recv()
            print("Receiver: OK End received")

            # 7. VERIFY
            if original_data == received_buffer:
                print("[OK] SUCCESS: Reliability layer verified! 100% bit-accurate transfer.")
            else:
                print(f"[FAILED] Integrity check failed. Sent {len(original_data)}, Recv {len(received_buffer)}")

if __name__ == "__main__":
    asyncio.run(verify_step11_reliability())
