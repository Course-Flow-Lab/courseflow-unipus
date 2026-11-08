import json
import os
import subprocess
import sys
import tempfile

import numpy as np
from faster_whisper import WhisperModel


def estimate_f0(audio, sample_rate=16000):
    frame_len = int(0.04 * sample_rate)
    hop = int(0.02 * sample_rate)
    values = []
    for start in range(0, max(0, len(audio) - frame_len), hop):
        frame = audio[start : start + frame_len]
        energy = float(np.sqrt(np.mean(frame * frame)))
        if energy < 0.006:
            continue
        centered = frame - float(np.mean(frame))
        corr = np.correlate(centered, centered, mode="full")[frame_len - 1 :]
        min_lag = max(1, int(sample_rate / 320))
        max_lag = min(len(corr) - 1, int(sample_rate / 70))
        if max_lag <= min_lag:
            continue
        peak = min_lag + int(np.argmax(corr[min_lag:max_lag]))
        if peak <= 0 or corr[peak] < 0.25 * corr[0]:
            continue
        f0 = sample_rate / peak
        if 70 <= f0 <= 320:
            values.append(f0)
    return float(np.median(values)) if values else 0.0


def label_segments(segments, audio, sample_rate=16000):
    measured = []
    for segment in segments:
        start = max(0, int(segment.start * sample_rate))
        end = min(len(audio), int(segment.end * sample_rate))
        f0 = estimate_f0(audio[start:end], sample_rate) if end > start else 0.0
        measured.append((segment, f0))
    values = sorted(f0 for _, f0 in measured if f0 > 0)
    if len(values) < 2 or values[-1] - values[0] < 35:
        return [(segment, "?") for segment, _ in measured]
    split = (values[0] + values[-1]) / 2
    return [(segment, "M" if f0 and f0 < split else "W" if f0 else "?") for segment, f0 in measured]


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
        segments = [segment for segment in segments if segment.text and segment.text.strip()]
        labeled_parts = []
        for segment, speaker in label_segments(segments, audio):
            text = segment.text.strip()
            if speaker == "?":
                labeled_parts.append(text)
            else:
                labeled_parts.append(f"{speaker}: {text}")
        text = " ".join(segment.text.strip() for segment in segments)
        return {
            "text": text,
            "labeled": "\n".join(labeled_parts),
            "segments": [
                {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                for segment in segments
            ],
        }
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
            output[item["id"]] = {"text": "", "labeled": "", "segments": []}
            print(f"{item['id']} failed: {error}", file=sys.stderr, flush=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
