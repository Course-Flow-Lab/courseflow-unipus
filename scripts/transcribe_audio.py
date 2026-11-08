import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from faster_whisper import WhisperModel


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: transcribe_audio.py <audio> [model]"}))
        return 2
    audio_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    pcm_path = os.path.join(tempfile.gettempdir(), f"courseflow-asr-{os.getpid()}.pcm")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                audio_path,
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "s16le",
                pcm_path,
            ],
            check=True,
        )
        audio = np.fromfile(pcm_path, dtype=np.int16).astype(np.float32) / 32768.0
        model = WhisperModel(model_name, device="cpu", compute_type="int8")
        segments, info = model.transcribe(
            audio,
            language="en",
            vad_filter=True,
            beam_size=5,
        )
        text = " ".join(
            segment.text.strip()
            for segment in segments
            if segment.text and segment.text.strip()
        )
        print(json.dumps({"text": text, "duration": info.duration}, ensure_ascii=False))
        return 0
    finally:
        try:
            os.remove(pcm_path)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
