import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from faster_whisper import WhisperModel


def transcribe(model, path):
    pcm_path = os.path.join(tempfile.gettempdir(), f"courseflow-ut-{os.getpid()}.pcm")
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-loglevel",
                "error",
                "-i",
                path,
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
        segments, _ = model.transcribe(
            audio,
            language="en",
            vad_filter=True,
            beam_size=5,
        )
        return " ".join(
            segment.text.strip()
            for segment in segments
            if segment.text and segment.text.strip()
        )
    finally:
        try:
            os.remove(pcm_path)
        except OSError:
            pass


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: transcribe_many.py <manifest.json> <output.json> [model]"}))
        return 2
    manifest_path = sys.argv[1]
    output_path = sys.argv[2]
    model_name = sys.argv[3] if len(sys.argv) > 3 else "base.en"
    with open(manifest_path, "r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    output = {}
    for index, item in enumerate(manifest, 1):
        print(f"[{index}/{len(manifest)}] {item['id']}", file=sys.stderr, flush=True)
        try:
            output[item["id"]] = transcribe(model, item["path"])
        except Exception as error:
            output[item["id"]] = ""
            print(f"{item['id']} failed: {error}", file=sys.stderr, flush=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
