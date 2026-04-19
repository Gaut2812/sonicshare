const TARGET_VIDEO_BITRATE = 900_000;
const TARGET_AUDIO_BITRATE = 96_000;
const MAX_FPS = 30;

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ];

  for (const mimeType of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType)) {
      return mimeType;
    }
  }

  return "";
}

function waitForEvent(target, eventName) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      target.removeEventListener(eventName, onEvent);
      target.removeEventListener("error", onError);
    };

    target.addEventListener(eventName, onEvent, { once: true });
    target.addEventListener("error", onError, { once: true });
  });
}

export async function maybeCompressVideo(file, onStatus = () => {}) {
  if (!file || !file.type?.startsWith("video/")) return file;

  const mimeType = pickMimeType();
  if (!mimeType) {
    onStatus("Video selected; codec compression not supported in this browser.");
    return file;
  }

  onStatus("Compressing video (same resolution)...");

  const srcUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.src = srcUrl;
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";

  try {
    await waitForEvent(video, "loadedmetadata");

    const width = Math.max(1, video.videoWidth || 1280);
    const height = Math.max(1, video.videoHeight || 720);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      onStatus("Video selected; canvas compression unavailable.");
      return file;
    }

    const fps = Math.min(MAX_FPS, Math.max(12, Math.round(video.duration ? 24 : 30)));
    const stream = canvas.captureStream(fps);

    let audioTrack;
    try {
      const mediaStream = video.captureStream?.() || video.mozCaptureStream?.();
      audioTrack = mediaStream?.getAudioTracks?.()[0];
      if (audioTrack) stream.addTrack(audioTrack);
    } catch {
      // ignore audio capture failures
    }

    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: TARGET_VIDEO_BITRATE,
      audioBitsPerSecond: audioTrack ? TARGET_AUDIO_BITRATE : undefined,
    });

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    };

    const drawFrame = () => {
      if (video.paused || video.ended) return;
      ctx.drawImage(video, 0, 0, width, height);
      requestAnimationFrame(drawFrame);
    };

    await video.play();
    drawFrame();
    recorder.start(1000);

    await waitForEvent(video, "ended");

    if (recorder.state !== "inactive") {
      await new Promise((resolve) => {
        recorder.onstop = resolve;
        recorder.stop();
      });
    }

    const blob = new Blob(chunks, { type: mimeType.split(";")[0] || "video/webm" });

    if (!blob.size || blob.size >= file.size) {
      onStatus("Compression kept original video (already optimized).", "var(--text-secondary)");
      return file;
    }

    const compressedFile = new File(
      [blob],
      file.name.replace(/\.[^.]+$/, "") + "-compressed.webm",
      {
        type: blob.type,
        lastModified: Date.now(),
      },
    );

    onStatus(
      `Video compressed: ${(file.size / 1048576).toFixed(1)}MB → ${(compressedFile.size / 1048576).toFixed(1)}MB`,
      "var(--success)",
    );

    return compressedFile;
  } catch (error) {
    console.warn("[VideoCompression] Falling back to original video:", error);
    onStatus("Video compression failed; sending original file.", "var(--error)");
    return file;
  } finally {
    URL.revokeObjectURL(srcUrl);
  }
}
