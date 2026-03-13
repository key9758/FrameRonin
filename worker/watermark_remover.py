"""
Seedance 2.0 水印去除
参考: https://github.com/SamurAIGPT/seedance-2.0-watermark-remover
去除 Seedance / 即梦 视频中的「AI生成」角标水印，使用 OpenCV TELEA 修复。
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np


def _auto_detect(frames: list, mean_frame: np.ndarray, width: int, height: int) -> Optional[tuple[int, int, int, int]]:
    """
    扫描四个角定位水印。
    评分: edge_density × temporal_stability
    """
    stack = np.stack(frames, axis=0)
    std_map = np.std(stack, axis=0).mean(axis=2)

    corner_h = max(60, int(height * 0.08))
    corner_w = max(120, int(width * 0.12))
    corners = [
        (0, 0, corner_h, corner_w),
        (0, width - corner_w, corner_h, width),
        (height - corner_h, 0, height, corner_w),
        (height - corner_h, width - corner_w, height, width),
    ]

    best, best_score = None, 0
    for r1, c1, r2, c2 in corners:
        roi_gray = cv2.cvtColor(mean_frame[r1:r2, c1:c2], cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(roi_gray, 20, 60)
        edge_density = edges.mean() / 255.0
        temporal_std = std_map[r1:r2, c1:c2].mean()
        stability = 1.0 / (1.0 + temporal_std)
        score = edge_density * stability

        if score > best_score and edge_density > 0.002:
            ys, xs = np.where(edges > 0)
            if len(xs) > 20:
                best_score = score
                pad = 8
                x = max(0, c1 + int(xs.min()) - pad)
                y = max(0, r1 + int(ys.min()) - pad)
                w = min(width - x, int(xs.max() - xs.min()) + 1 + 2 * pad)
                h = min(height - y, int(ys.max() - ys.min()) + 1 + 2 * pad)
                best = (x, y, w, h)

    return best


def _build_mask(mean_frame_bgr: np.ndarray, region_xywh: tuple, frame_shape: tuple) -> np.ndarray:
    """使用 Canny 边缘检测在平均帧上构建文本蒙版"""
    x, y, w, h = region_xywh
    H, W = frame_shape[:2]
    roi_gray = cv2.cvtColor(mean_frame_bgr[y:y + h, x:x + w], cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(roi_gray, 30, 80)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    dilated = cv2.dilate(edges, kernel, iterations=1)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(dilated)
    clean = np.zeros_like(dilated)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 100:
            clean[labels == i] = 255
    if clean.sum() == 0:
        clean = np.full((h, w), 255, dtype=np.uint8)
    mask = np.zeros((H, W), dtype=np.uint8)
    mask[y:y + h, x:x + w] = clean
    return mask


def remove_watermark(
    input_path: str,
    output_path: str,
    manual_region: Optional[tuple[int, int, int, int]] = None,
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> bool:
    """
    去除视频水印。返回是否成功。
    on_progress: (current, total) -> None，可选进度回调。
    """
    cap = cv2.VideoCapture(input_path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    # 采样帧 → 平均帧
    sample_frames = []
    step = max(1, total // 60)
    for i in range(0, total, step):
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ret, f = cap.read()
        if ret:
            sample_frames.append(f.astype(np.float32))
        if len(sample_frames) >= 60:
            break

    if not sample_frames:
        cap.release()
        return False

    mean_frame = np.mean(np.stack(sample_frames), axis=0).astype(np.uint8)

    # 检测 / 手动区域
    if manual_region:
        x, y, w, h = manual_region
    else:
        region = _auto_detect(sample_frames, mean_frame, width, height)
        if region is None:
            cap.release()
            return False
        x, y, w, h = region

    mask = _build_mask(mean_frame, (x, y, w, h), (height, width))

    # 逐帧修复
    frames_dir = tempfile.mkdtemp(prefix="seedance_wm_")
    try:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        for i in range(total):
            ret, frame = cap.read()
            if not ret:
                break
            result = cv2.inpaint(frame, mask, inpaintRadius=5, flags=cv2.INPAINT_TELEA)
            cv2.imwrite(os.path.join(frames_dir, f"{i:06d}.png"), result)
            if on_progress and (i + 1) % 10 == 0:
                on_progress(i + 1, total)
        cap.release()

        # ffmpeg 重组
        cmd = [
            "ffmpeg", "-y",
            "-framerate", str(fps),
            "-i", os.path.join(frames_dir, "%06d.png"),
            "-i", input_path,
            "-map", "0:v",
            "-map", "1:a?",
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
            "-pix_fmt", "yuv420p",
            "-c:a", "copy",
            "-movflags", "+faststart",
            output_path,
        ]
        ret_code = subprocess.run(cmd, capture_output=True).returncode
    finally:
        shutil.rmtree(frames_dir, ignore_errors=True)

    return ret_code == 0


def run_watermark_pipeline(job_id: str, video_path: str, output_base: str) -> dict:
    """
    水印去除管线入口，供 RQ worker 调用。
    输出: output_base/job_id/clean.mp4
    """
    vpath = Path(video_path)
    if not vpath.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    out_dir = Path(output_base) / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    output_file = out_dir / "clean.mp4"

    ok = remove_watermark(str(vpath), str(output_file))
    if not ok:
        raise RuntimeError("Watermark removal failed")
    return {"output": str(output_file)}
