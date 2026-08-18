# SonicShare ⚡

### Fast, Secure & Resilient Peer-to-Peer File Sharing

SonicShare is a **peer-to-peer file-sharing system** designed to transfer large files directly between devices without relying on traditional cloud storage.

The project uses **WebRTC DataChannels** for direct data transfer, with a relay-assisted architecture for establishing connectivity when direct peer-to-peer communication is not immediately possible.

---

## 🚀 Why SonicShare?

Traditional file-sharing systems often depend on:

* Cloud uploads
* Temporary storage
* File-size restrictions
* Slow upload/download pipelines
* Third-party servers

SonicShare aims to minimize these limitations by transferring data **directly between peers** whenever possible.

```text
Sender
   │
   │ WebRTC DataChannel
   ▼
Receiver
```

The server primarily assists with **signaling and session coordination**, rather than storing the transferred files.

---

## ✨ Key Features

### 🔗 Peer-to-Peer Transfer

Uses WebRTC DataChannels to establish a direct connection between sender and receiver.

### 📦 Chunked File Transfer

Large files are divided into manageable chunks before transmission.

```text
Large File
    │
    ├── Chunk 0
    ├── Chunk 1
    ├── Chunk 2
    ├── Chunk 3
    └── ...
```

This allows the application to process large files without loading the entire file into memory.

### 🔐 End-to-End Encryption

File data can be encrypted before transmission using cryptographic key exchange mechanisms.

The architecture uses **ECDH-based key exchange** for establishing shared encryption material.

### 📊 Adaptive Chunking

SonicShare monitors network conditions such as RTT and adjusts transfer parameters dynamically.

Example:

```text
Network RTT
    ↓
Adaptive Controller
    ↓
Chunk Size
    ↓
Transfer Performance
```

### 🧠 Flow Control

Large-file transfers require careful handling of the WebRTC send buffer.

SonicShare monitors:

```javascript
dataChannel.readyState
dataChannel.bufferedAmount
```

to prevent sending data faster than the channel can process it.

### 🔄 Transfer Reliability

The protocol supports mechanisms for:

* Sequence numbers
* Chunk tracking
* Retry handling
* Transfer state management
* Connection-state monitoring

### ⚡ Large File Optimization

Special attention is given to large files where aggressive sending can cause:

```text
RTCDataChannel
      ↓
Buffer pressure
      ↓
Channel instability
      ↓
Transfer failure
```

The transfer pipeline therefore uses safer packet sizes and send pacing.

---

# 🏗️ Architecture

```text
                    ┌─────────────────────┐
                    │   SonicShare Client │
                    │                     │
                    │ File Manager        │
                    │ Chunk Manager       │
                    │ Encryption          │
                    │ Transfer Protocol   │
                    └──────────┬──────────┘
                               │
                               │ WebSocket
                               ▼
                    ┌─────────────────────┐
                    │  Signaling Server   │
                    │                     │
                    │ Session Management  │
                    │ Peer Discovery      │
                    │ Connection Setup    │
                    └──────────┬──────────┘
                               │
                         WebRTC Signaling
                               │
                ┌──────────────┴──────────────┐
                │                             │
                ▼                             ▼
        ┌──────────────┐             ┌──────────────┐
        │    Sender    │◄───────────►│   Receiver   │
        │              │  WebRTC P2P │              │
        └──────────────┘             └──────────────┘
```

---

# 🔄 File Transfer Pipeline

```text
Select File
     │
     ▼
Read File
     │
     ▼
Split Into Chunks
     │
     ▼
Encrypt Chunk
     │
     ▼
Build Transfer Packet
     │
     ▼
Check DataChannel
     │
     ▼
Check Buffered Amount
     │
     ▼
Send Chunk
     │
     ▼
Receiver Validates
     │
     ▼
Decrypt Chunk
     │
     ▼
Reassemble File
     │
     ▼
Download
```

---

# 🛡️ Large File Transfer Strategy

One of the main engineering challenges in SonicShare is reliable transfer of files larger than a few megabytes.

During testing, small files transferred successfully while larger transfers could cause the WebRTC DataChannel to close unexpectedly.

The failure pattern was:

```text
Starting Transfer
       ↓
Multiple large packets
       ↓
Send Buffer Pressure
       ↓
RTCErrorEvent
       ↓
DataChannel CLOSED
       ↓
InvalidStateError
```

The solution is to introduce controlled transmission.

### Safe Sending

```javascript
async function safeSend(channel, packet) {
    if (channel.readyState !== "open") {
        throw new Error("DataChannel is not open");
    }

    while (channel.bufferedAmount > MAX_BUFFER) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }

    channel.send(packet);
}
```

This prevents the sender from continuously pushing data into an overloaded DataChannel.

---

# 📦 Recommended Packet Size

The application should keep packet sizes conservative rather than aggressively increasing chunk sizes.

For example:

```javascript
const CHUNK_SIZE = 256 * 1024;
```

The adaptive controller can adjust the size based on network conditions while respecting a safe upper limit.

```text
Adaptive Size
      │
      ▼
┌───────────────┐
│ Safety Limit  │
│    256 KB     │
└───────┬───────┘
        │
        ▼
Actual Chunk Size
```

---

# ⚙️ Send Pacing

Instead of sending packets continuously:

```javascript
send(packet);
send(packet);
send(packet);
send(packet);
```

SonicShare uses controlled transmission:

```javascript
await safeSend(channel, packet);
await delay(1);
```

This reduces buffer pressure and improves stability during large transfers.

---

# 🔍 Transfer State Monitoring

The DataChannel state must be checked before every transmission.

```javascript
if (dataChannel.readyState !== "open") {
    console.warn("DataChannel is not available");
    return;
}
```

The system also monitors channel lifecycle events:

```javascript
dataChannel.onopen = () => {
    console.log("DataChannel opened");
};

dataChannel.onclose = () => {
    console.log("DataChannel closed");
};

dataChannel.onerror = (error) => {
    console.error("DataChannel error:", error);
};
```

---

# 🧩 Core Components

| Component           | Responsibility                     |
| ------------------- | ---------------------------------- |
| WebRTC Layer        | Peer-to-peer communication         |
| Signaling Layer     | Peer/session coordination          |
| Transfer Protocol   | Packet construction and sequencing |
| Chunk Manager       | Splitting and reconstructing files |
| Encryption Layer    | Secure file transmission           |
| Flow Controller     | Controls send-buffer pressure      |
| Retry Manager       | Handles failed chunks              |
| RTT Monitor         | Tracks network performance         |
| Adaptive Controller | Adjusts transfer parameters        |

---

# 📈 Performance Goals

SonicShare is designed with large-file transfers as a primary target.

| File Size | Target                       |
| --------- | ---------------------------- |
| < 1 MB    | Near-instant transfer        |
| 10 MB     | Stable transfer              |
| 100 MB    | Reliable transfer            |
| 1 GB+     | Stable long-running transfer |

Actual transfer speed depends on:

* Network bandwidth
* Wi-Fi/Ethernet conditions
* Browser implementation
* Device performance
* WebRTC congestion control
* Peer distance
* NAT traversal conditions

---

# 🛠️ Technology Stack

### Frontend

* JavaScript / TypeScript
* WebRTC
* WebSocket
* IndexedDB

### Backend

* Python
* FastAPI
* WebSocket

### Networking

* WebRTC DataChannel
* STUN/TURN
* WebSocket Signaling

### Security

* ECDH
* Encrypted file chunks
* Session-based communication

---

# 📂 Project Structure

```text
sonic-share/
│
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   ├── services/
│   │   ├── protocol.js
│   │   ├── webrtc.js
│   │   └── config.js
│   │
│   └── package.json
│
├── backend/
│   ├── main.py
│   ├── signaling/
│   └── requirements.txt
│
├── docs/
│
└── README.md
```

> Adjust the structure above to match the current repository before committing.

---

# 🚦 Getting Started

## 1. Clone the Repository

```bash
git clone https://github.com/<your-username>/sonic-share.git
cd sonic-share
```

## 2. Install Frontend Dependencies

```bash
cd frontend
npm install
```

## 3. Start the Frontend

```bash
npm run dev
```

## 4. Start the Backend

```bash
cd backend

pip install -r requirements.txt

uvicorn main:app --reload
```

---

# 🔧 Configuration

Example configuration:

```javascript
const CHUNK_SIZE = 256 * 1024;

const MAX_BUFFER = 2 * 1024 * 1024;
```

These values should be tuned according to browser behavior and network conditions.

---

# 🧪 Testing Large Files

Test progressively larger files:

```text
500 KB
   ↓
10 MB
   ↓
50 MB
   ↓
100 MB
   ↓
500 MB
   ↓
1 GB+
```

Monitor:

```text
DataChannel State
Buffered Amount
RTT
Chunk Size
Transfer Rate
Retries
Failed Chunks
```

A successful large-file transfer should maintain:

```text
readyState = open
bufferedAmount = controlled
retries = low
channel errors = 0
```

---

# 🐛 Known Challenge

The primary engineering challenge is maintaining **DataChannel stability during high-throughput transfers**.

A typical failure looks like:

```text
RTCErrorEvent
      ↓
DataChannel CLOSED
      ↓
InvalidStateError:
RTCDataChannel.readyState is not 'open'
```

This is addressed through:

* Smaller packet sizes
* Send-buffer monitoring
* Transmission pacing
* DataChannel state validation
* Controlled retries
* Adaptive transfer parameters

---

# 🚀 Future Improvements

### 1. Multi-Channel Transfer

Distribute chunks across multiple WebRTC DataChannels:

```text
Channel 1 → 0, 4, 8, 12...
Channel 2 → 1, 5, 9, 13...
Channel 3 → 2, 6, 10, 14...
Channel 4 → 3, 7, 11, 15...
```

### 2. Advanced Congestion Control

Implement a BBR-inspired application-level scheduler to dynamically control:

* Send window
* Throughput
* RTT
* Buffer pressure
* Packet pacing

### 3. Resume Interrupted Transfers

Allow users to continue a transfer after:

```text
Browser refresh
Network interruption
Temporary peer disconnect
```

### 4. Transfer Verification

Use streaming hashes to verify that:

```text
Source File Hash
        ==
Received File Hash
```

### 5. Improved NAT Traversal

Add robust STUN/TURN infrastructure for difficult network environments.

---

# 🔐 Security Considerations

SonicShare is designed to avoid storing user files on the signaling server.

Security mechanisms include:

* Peer-to-peer transfer
* Session-based communication
* ECDH key exchange
* Encrypted file chunks
* Transfer integrity verification

Never commit secrets or credentials to the repository.

Use environment variables for:

```text
STUN/TURN credentials
API keys
Server secrets
Database credentials
```

---

# 📊 Project Focus

SonicShare is not simply a file-upload application.

The project focuses on solving a real networking problem:

> **How can large files be transferred directly between peers while maintaining security, reliability and high throughput?**

The main engineering focus is therefore:

```text
P2P Networking
      +
Large File Streaming
      +
Flow Control
      +
Encryption
      +
Reliability
      +
Performance Optimization
```

---

# 🤝 Contributing

Contributions are welcome.

```bash
git checkout -b feature/your-feature
```

Make your changes, test large-file transfers, and submit a pull request.

---

# 📄 License

Add your preferred license here, for example:

```text
MIT License
```

---

## ⭐ Project Status

**Active Development**

SonicShare is currently being optimized for reliable **large-file peer-to-peer transfers**, with particular focus on WebRTC DataChannel flow control, adaptive chunking, encryption, and transfer reliability.

---

### Built with ⚡ for faster peer-to-peer file sharing.
