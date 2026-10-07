#!/usr/bin/env python3
"""Split a green/blue-screen pack video into one clean clip per animation.

A clip is a run of frames with something on the green. Clips are split where
the frame is empty green for a few frames or the green shade changes. Blue
screens work too. A clip touching the start or end of the file may be cut off
mid-animation; it is kept with an _edge suffix so you can judge it.

usage: tools/cutpack.py <video.mp4> [outdir]   (default: <video dir>/clips/)
"""
import json, os, re, subprocess, sys
import numpy as np

W, H = 160, 90
GAP = 3          # empty frames that end a clip
MIN_LEN = 10     # frames; shorter runs are noise
EMPTY = 0.004
SHADE = 15       # a green this different is a new clip    # share of non-green pixels that still counts as empty

def probe(f):
    out = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                          'stream=r_frame_rate', '-of', 'json', f], capture_output=True, text=True).stdout
    n, d = json.loads(out)['streams'][0]['r_frame_rate'].split('/')
    return float(n) / float(d)

def frames(f):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f, '-vf', f'scale={W}:{H}', '-f', 'rawvideo',
                          '-pix_fmt', 'rgb24', '-'], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3).astype(int)

def scan(a):
    rows = []
    for fr in a:
        r, g, b = fr[..., 0], fr[..., 1], fr[..., 2]
        green = (g > 120) & (g > r + 40) & (g > b + 60)
        blue = (b > 120) & (b > r + 60) & (b > g + 60)
        bg = blue if blue.mean() > green.mean() else green
        shade = np.median(fr[bg], axis=0) if bg.mean() > 0.3 else None
        rows.append((1 - bg.mean(), shade))
    return rows

def segments(rows):
    segs, cur, empty, shade = [], None, 0, None
    for i, (content, s) in enumerate(rows):
        if s is not None and shade is not None and np.abs(s - shade).max() > SHADE and cur:
            segs.append(cur); cur = None
        if s is not None:
            shade = s
        if content > EMPTY:
            cur = [cur[0], i] if cur else [i, i]
            empty = 0
        else:
            empty += 1
            if cur and empty >= GAP:
                segs.append(cur); cur = None
    if cur:
        segs.append(cur)
    n = len(rows)
    return [(a, b, a == 0 or b == n - 1) for a, b in segs if b - a + 1 >= MIN_LEN]

def main():
    src = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(src) or '.', 'clips')
    os.makedirs(out, exist_ok=True)
    fps = probe(src)
    base = re.sub(r'[^A-Za-z0-9]+', '_', os.path.splitext(os.path.basename(src))[0]).strip('_')
    rows = scan(frames(src))
    segs = segments(rows)
    n = len(rows)
    for k, (a, b, edge) in enumerate(segs, 1):
        a, b = max(0, a - 1), min(n - 1, b + 1)   # one frame of clean screen either side
        dst = os.path.join(out, f'{base}_{k:02d}{"_edge" if edge else ""}.mp4')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', src, '-ss', f'{a / fps:.4f}',
                        '-frames:v', str(b - a + 1), '-t', f'{(b - a + 1) / fps:.4f}',
                        '-c:v', 'libx264', '-crf', '14', '-preset', 'slow', '-pix_fmt', 'yuv420p',
                        '-c:a', 'aac', '-b:a', '192k', dst], check=True)
        print(f'{dst}  {a / fps:6.2f}s - {(b + 1) / fps:6.2f}s  ({b - a + 1} frames)')

if __name__ == '__main__':
    main()
