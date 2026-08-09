"""Container-accurate resource measurement.

WHY. Stage 2 Run 1 measured memory with `free -m` and CPU with `nproc`. Inside
a container both report the HOST: Run 1 recorded 515 612 MiB and 128 vCPU
against a pod allocation of 62 GB and 16 vCPU. Every memory number it produced
was therefore meaningless, and §6 measurement 6 — peak RSS against the pod
limit — could not be computed at all.

This module reads the cgroup instead, so "peak RSS vs limit" is a real ratio.

Pure stdlib. Safe to import anywhere; every reader degrades to None rather than
raising, because a measurement tool must never be the thing that fails a parse.
"""

from __future__ import annotations

import os
import time
from pathlib import Path

CG = Path("/sys/fs/cgroup")


def _read_int(p: Path) -> int | None:
    try:
        v = p.read_text().strip()
    except OSError:
        return None
    if v in ("max", ""):
        return None
    try:
        return int(v)
    except ValueError:
        return None


def _read_kv(p: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        for line in p.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1].lstrip("-").isdigit():
                out[parts[0]] = int(parts[1])
    except OSError:
        pass
    return out


def cgroup_version() -> str:
    if (CG / "cgroup.controllers").exists():
        return "v2"
    if (CG / "memory" / "memory.usage_in_bytes").exists():
        return "v1"
    return "none"


def memory_current_bytes() -> int | None:
    """Current charge for this container, not the host."""
    v = _read_int(CG / "memory.current")
    if v is not None:
        return v
    return _read_int(CG / "memory" / "memory.usage_in_bytes")


def memory_peak_bytes() -> int | None:
    """Kernel-tracked high-water mark, when the kernel exposes one.

    memory.peak is not universally present. When absent the caller must fall
    back to sampling memory.current, which is what ResourceSampler does.
    """
    v = _read_int(CG / "memory.peak")
    if v is not None:
        return v
    return _read_int(CG / "memory" / "memory.max_usage_in_bytes")


def memory_limit_bytes() -> int | None:
    """The actual pod limit. None means unlimited/not enforced here."""
    v = _read_int(CG / "memory.max")
    if v is not None:
        return v
    v = _read_int(CG / "memory" / "memory.limit_in_bytes")
    # cgroup v1 signals "no limit" with a nonsense-large sentinel.
    if v is not None and v > (1 << 62):
        return None
    return v


def cpu_quota_cores() -> float | None:
    """Effective CPU allocation, not the host core count."""
    try:
        raw = (CG / "cpu.max").read_text().split()
        if len(raw) == 2 and raw[0] != "max":
            return int(raw[0]) / int(raw[1])
    except (OSError, ValueError, ZeroDivisionError):
        pass
    quota = _read_int(CG / "cpu" / "cpu.cfs_quota_us")
    period = _read_int(CG / "cpu" / "cpu.cfs_period_us")
    if quota and period and quota > 0:
        return quota / period
    return None


def process_tree_rss_bytes() -> int | None:
    """Summed RSS of every process in this container, via /proc.

    Complements the cgroup figure: cgroup memory.current includes page cache,
    which inflates it. RSS is the number that answers "would this OOM".
    """
    total = 0
    seen = False
    try:
        for entry in os.listdir("/proc"):
            if not entry.isdigit():
                continue
            try:
                for line in Path(f"/proc/{entry}/status").read_text().splitlines():
                    if line.startswith("VmRSS:"):
                        total += int(line.split()[1]) * 1024
                        seen = True
                        break
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return None
    return total if seen else None


def gpu_vram_used_mib() -> int | None:
    import subprocess
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=15,
        ).stdout.strip().splitlines()
        return int(out[0]) if out and out[0].strip().isdigit() else None
    except Exception:  # noqa: BLE001 - a probe must never raise
        return None


def snapshot() -> dict:
    limit = memory_limit_bytes()
    cur = memory_current_bytes()
    rss = process_tree_rss_bytes()
    pct = round(100.0 * cur / limit, 2) if (cur and limit) else None
    rss_pct = round(100.0 * rss / limit, 2) if (rss and limit) else None
    return {
        "cgroupVersion": cgroup_version(),
        "memoryCurrentBytes": cur,
        "memoryPeakBytes": memory_peak_bytes(),
        "memoryLimitBytes": limit,
        "memoryCurrentPctOfLimit": pct,
        "processTreeRssBytes": rss,
        "processTreeRssPctOfLimit": rss_pct,
        "cpuQuotaCores": cpu_quota_cores(),
        "gpuVramUsedMib": gpu_vram_used_mib(),
    }


class ResourceSampler:
    """Background high-water sampler for a timed task.

    Used by the Stage 2 benchmark so peak container RSS can be reported against
    the pod limit — the comparison Run 1 could not make.
    """

    def __init__(self, interval_s: float = 0.25) -> None:
        self.interval_s = interval_s
        self.peak_mem_current = 0
        self.peak_rss = 0
        self.peak_vram_mib = 0
        self.limit = memory_limit_bytes()
        self._stop = None
        self._thread = None
        self._t0 = 0.0
        self.duration_s = 0.0

    def __enter__(self) -> "ResourceSampler":
        import threading
        self._stop = threading.Event()
        self._t0 = time.time()

        def loop() -> None:
            while not self._stop.is_set():
                c = memory_current_bytes()
                if c:
                    self.peak_mem_current = max(self.peak_mem_current, c)
                r = process_tree_rss_bytes()
                if r:
                    self.peak_rss = max(self.peak_rss, r)
                v = gpu_vram_used_mib()
                if v:
                    self.peak_vram_mib = max(self.peak_vram_mib, v)
                self._stop.wait(self.interval_s)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        if self._stop:
            self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.duration_s = round(time.time() - self._t0, 3)

    def result(self) -> dict:
        kpeak = memory_peak_bytes()
        return {
            "durationS": self.duration_s,
            "peakMemoryCurrentBytes": self.peak_mem_current or None,
            "kernelMemoryPeakBytes": kpeak,
            "peakProcessTreeRssBytes": self.peak_rss or None,
            "memoryLimitBytes": self.limit,
            "peakRssPctOfLimit": (round(100.0 * self.peak_rss / self.limit, 2)
                                  if self.peak_rss and self.limit else None),
            "peakVramMib": self.peak_vram_mib or None,
        }


if __name__ == "__main__":
    import json
    print(json.dumps(snapshot(), indent=2))
