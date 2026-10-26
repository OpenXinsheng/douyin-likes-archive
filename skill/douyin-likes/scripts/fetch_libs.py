#!/usr/bin/env python3
"""免 root 解决 Chromium 缺失的共享库。

思路：
  1. ldd 扫描浏览器目录下所有 ELF 文件，收集 "not found" 的库名
  2. 把库名映射成 apt 包名（内置字典 + 启发式 + packages.ubuntu.com 兜底）
  3. apt-get download 拉 .deb 到 workspace，dpkg-deb -x 解包到 vendor/libs
  4. 重复 1-3 直到没有缺失，最后输出需要设置的 LD_LIBRARY_PATH

用法：
  python3 scripts/fetch_libs.py browsers/chromium-*/chrome-linux/chrome
"""
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__import__("os").environ.get("DOUYIN_ROOT", Path(__file__).resolve().parent.parent)).resolve()
LIBS = ROOT / "vendor" / "libs"
DEBS = ROOT / "vendor" / "debs"

# Ubuntu 26.04 (t64 过渡) 下常见的库 -> 包名，启发式猜不中的都在这里
KNOWN = {
    "libnss3.so": "libnss3",
    "libnssutil3.so": "libnss3",
    "libsmime3.so": "libnss3",
    "libssl3.so": "libnss3",
    "libnspr4.so": "libnspr4",
    "libplc4.so": "libnspr4",
    "libplds4.so": "libnspr4",
    "libasound.so.2": "libasound2t64",
    "libatk-1.0.so.0": "libatk1.0-0t64",
    "libatk-bridge-2.0.so.0": "libatk-bridge2.0-0t64",
    "libatspi.so.0": "libatspi2.0-0t64",
    "libcups.so.2": "libcups2t64",
    "libglib-2.0.so.0": "libglib2.0-0t64",
    "libgobject-2.0.so.0": "libglib2.0-0t64",
    "libgio-2.0.so.0": "libglib2.0-0t64",
    "libgmodule-2.0.so.0": "libglib2.0-0t64",
    "libpng16.so.16": "libpng16-16t64",
    "libpango-1.0.so.0": "libpango-1.0-0",
    "libpangocairo-1.0.so.0": "libpango-1.0-0",
    "libpangoft2-1.0.so.0": "libpango-1.0-0",
    "libharfbuzz.so.0": "libharfbuzz0b",
    "libgraphite2.so.3": "libgraphite2-3",
    "libfontconfig.so.1": "libfontconfig1",
    "libfreetype.so.6": "libfreetype6",
    "libcairo.so.2": "libcairo2",
    "libpixman-1.so.0": "libpixman-1-0",
    "libX11.so.6": "libx11-6",
    "libX11-xcb.so.1": "libx11-xcb1",
    "libxcb.so.1": "libxcb1",
    "libXcomposite.so.1": "libxcomposite1",
    "libXdamage.so.1": "libxdamage1",
    "libXext.so.6": "libxext6",
    "libXfixes.so.3": "libxfixes3",
    "libXrandr.so.2": "libxrandr2",
    "libXrender.so.1": "libxrender1",
    "libXau.so.6": "libxau6",
    "libXdmcp.so.6": "libxdmcp6",
    "libxkbcommon.so.0": "libxkbcommon0",
    "libxshmfence.so.1": "libxshmfence1",
    "libgbm.so.1": "libgbm1",
    "libdrm.so.2": "libdrm2",
    "libEGL.so.1": "libegl1",
    "libGLESv2.so.2": "libgles2",
    "libGL.so.1": "libgl1",
    "libdbus-1.so.3": "libdbus-1-3",
    "libexpat.so.1": "libexpat1",
    "libuuid.so.1": "libuuid1",
    "libz.so.1": "libz1",
    "libzstd.so.1": "libzstd1",
    "liblzma.so.5": "liblzma5",
    "liblz4.so.1": "liblz4-1",
    "libbrotlidec.so.1": "libbrotli1",
    "libbrotlicommon.so.1": "libbrotli1",
    "libbsd.so.0": "libbsd0",
    "libmd.so.0": "libmd0",
    "libcap.so.2": "libcap2",
    "libffi.so.8": "libffi8",
    "libpcre2-8.so.0": "libpcre2-8-0",
    "libselinux.so.1": "libselinux1",
    "libmount.so.1": "libmount1",
    "libblkid.so.1": "libblkid1",
    "libsystemd.so.0": "libsystemd0",
    "libgcrypt.so.20": "libgcrypt20",
    "libgpg-error.so.0": "libgpg-error0",
    "liblzma.so.5": "liblzma5",
    "libxcb-render.so.0": "libxcb-render0",
    "libxcb-shm.so.0": "libxcb-shm0",
    "libwayland-client.so.0": "libwayland-client0",
    "libwayland-server.so.0": "libwayland-server0",
    "libwayland-egl.so.1": "libwayland-egl1",
    "libresolv.so.2": "libc6",
    "libm.so.6": "libc6",
    "libc.so.6": "libc6",
    "libdl.so.2": "libc6",
    "libpthread.so.0": "libc6",
    "librt.so.1": "libc6",
}


def elf_files(target: Path):
    if target.is_file():
        return [target]
    out = []
    for p in target.rglob("*"):
        if not p.is_file():
            continue
        try:
            with open(p, "rb") as f:
                if f.read(4) != b"\x7fELF":
                    continue
        except OSError:
            continue
        out.append(p)
    return out


def missing_libs(target: Path, extra_path: str):
    env = dict(os.environ, LD_LIBRARY_PATH=extra_path)
    missing = set()
    for f in elf_files(target):
        try:
            r = subprocess.run(["ldd", str(f)], capture_output=True, text=True, env=env, timeout=60)
        except (subprocess.TimeoutExpired, OSError):
            continue
        for line in r.stdout.splitlines():
            if "not found" in line:
                missing.add(line.strip().split()[0])
    return missing


def pkg_candidates(lib: str) -> list[str]:
    """一个缺失库可能有多个候选包名，逐个试（启发式经常猜不中）"""
    out = []
    if lib in KNOWN:
        out.append(KNOWN[lib])
    m = re.match(r"^(lib.+?)\.so\.(\d+)", lib)
    if m:
        base, ver = m.group(1), m.group(2)
        out += [f"{base}{ver}".lower(), base.lower(), f"{base}{ver}t64".lower()]
    # 去重保序
    seen, uniq = set(), []
    for p in out:
        if p not in seen:
            seen.add(p); uniq.append(p)
    return uniq


def apt_download(pkg: str) -> bool:
    DEBS.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(
        ["apt-get", "download", pkg],
        cwd=str(DEBS), capture_output=True, text=True, timeout=300,
    )
    return r.returncode == 0


def extract_all():
    LIBS.mkdir(parents=True, exist_ok=True)
    for deb in DEBS.glob("*.deb"):
        subprocess.run(
            ["dpkg-deb", "-x", str(deb), str(LIBS)],
            capture_output=True, text=True,
        )


def lib_paths():
    dirs = []
    for sub in ("usr/lib/x86_64-linux-gnu", "lib/x86_64-linux-gnu", "usr/lib64", "lib64"):
        d = LIBS / sub
        if d.is_dir():
            dirs.append(str(d))
    return ":".join(dirs)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    target = Path(sys.argv[1]).resolve()
    if not target.exists():
        print(f"找不到目标: {target}", file=sys.stderr)
        sys.exit(1)

    for round_no in range(1, 6):
        lp = lib_paths()
        miss = missing_libs(target, lp)
        # 过滤掉 libc 自带的那几个（永远能从系统拿到）
        miss = {m for m in miss if m not in ("libc.so.6", "libm.so.6")}
        print(f"\n=== 第 {round_no} 轮：缺 {len(miss)} 个库")
        if not miss:
            print("全部依赖已满足")
            break
        tried = set()
        got = 0
        for lib in sorted(miss):
            for cand in pkg_candidates(lib):
                if cand in tried:
                    continue
                tried.add(cand)
                if apt_download(cand):
                    print(f"  {lib} <- {cand} ✅")
                    got += 1
                    break
            else:
                print(f"  {lib} <- 未找到可用包（试过 {pkg_candidates(lib)}）")
        print(f"本轮成功 {got}/{len(miss)}")
        extract_all()

    lp = lib_paths()
    miss = missing_libs(target, lp)
    miss = {m for m in miss if m not in ("libc.so.6", "libm.so.6")}
    print("\n===== 结果 =====")
    print("LD_LIBRARY_PATH=" + lp)
    if miss:
        print("仍缺:", sorted(miss))
        sys.exit(2)
    print("可用 ✅")


if __name__ == "__main__":
    main()
