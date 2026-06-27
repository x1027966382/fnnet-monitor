"""FNNet Monitor — lightweight NAS system monitoring tool."""

import json
import time
import subprocess
import logging
import threading
from datetime import datetime

import psutil
from flask import Flask, Response, render_template, jsonify

app = Flask(__name__)

# Configure logging
logging.basicConfig(level=logging.WARNING)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Global state for network speed calculation
# ---------------------------------------------------------------------------
_net_lock = threading.Lock()
_net_prev = psutil.net_io_counters(pernic=True)
_net_prev_ts = time.time()


def _cpu_info():
    """CPU usage, frequency, temperature, per-core info."""
    freq = psutil.cpu_freq(percpu=True) or []
    # Non-blocking: interval=0 returns instantaneous usage
    usage_per = psutil.cpu_percent(interval=0, percpu=True)
    load1, load5, load15 = psutil.getloadavg()

    # Try to get temperature from thermal zones
    temps = {}
    try:
        if hasattr(psutil, "sensors_temperatures"):
            raw = psutil.sensors_temperatures()
            for name, entries in raw.items():
                if entries:
                    temps[name] = [{"label": e.label or name, "current": e.current,
                                    "high": e.high, "critical": e.critical} for e in entries]
    except Exception:
        pass

    # CPU model from /proc/cpuinfo
    model = "Unknown"
    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if "model name" in line:
                    model = line.split(":", 1)[1].strip()
                    break
    except Exception:
        pass

    # usage_total: need two calls with small delay for accurate reading
    # First call primes the counter, second call gets real value
    try:
        psutil.cpu_percent(interval=None)
        time.sleep(0.05)
        usage_total = psutil.cpu_percent(interval=None)
    except Exception:
        usage_total = 0

    return {
        "model": model,
        "physical_cores": psutil.cpu_count(logical=False) or 0,
        "logical_cores": psutil.cpu_count(logical=True) or 0,
        "usage_total": usage_total,
        "usage_per_core": usage_per,
        "frequency": [{"current": f.current, "min": f.min, "max": f.max} for f in freq],
        "load_avg": {"1m": round(load1, 2), "5m": round(load5, 2), "15m": round(load15, 2)},
        "temperatures": temps,
    }


def _memory_info():
    """RAM and swap usage."""
    vm = psutil.virtual_memory()
    sw = psutil.swap_memory()
    return {
        "total": vm.total,
        "used": vm.used,
        "available": vm.available,
        "percent": vm.percent,
        "buffers": getattr(vm, "buffers", 0),
        "cached": getattr(vm, "cached", 0),
        "swap_total": sw.total,
        "swap_used": sw.used,
        "swap_percent": sw.percent,
    }


def _network_info():
    """Network I/O, per-nic stats, speed."""
    global _net_prev, _net_prev_ts
    current = psutil.net_io_counters(pernic=True)
    now = time.time()

    with _net_lock:
        dt = now - _net_prev_ts
        # Cap dt to avoid huge speeds on first request after long idle
        if dt <= 0 or dt > 60:
            dt = 2.0

        interfaces = {}
        for nic, counters in current.items():
            prev = _net_prev.get(nic)
            if prev:
                interfaces[nic] = {
                    "bytes_sent": counters.bytes_sent,
                    "bytes_recv": counters.bytes_recv,
                    "speed_sent": (counters.bytes_sent - prev.bytes_sent) / dt,
                    "speed_recv": (counters.bytes_recv - prev.bytes_recv) / dt,
                    "packets_sent": counters.packets_sent,
                    "packets_recv": counters.packets_recv,
                    "errin": counters.errin,
                    "errout": counters.errout,
                }
            else:
                interfaces[nic] = {
                    "bytes_sent": counters.bytes_sent,
                    "bytes_recv": counters.bytes_recv,
                    "speed_sent": 0,
                    "speed_recv": 0,
                    "packets_sent": counters.packets_sent,
                    "packets_recv": counters.packets_recv,
                    "errin": counters.errin,
                    "errout": counters.errout,
                }

        _net_prev = current
        _net_prev_ts = now

    total = psutil.net_io_counters()
    # Addrs
    addrs = {}
    try:
        for nic, a_list in psutil.net_if_addrs().items():
            addrs[nic] = [a._asdict() for a in a_list]
    except Exception:
        pass

    return {
        "total_sent": total.bytes_sent,
        "total_recv": total.bytes_recv,
        "total_packets_sent": total.packets_sent,
        "total_packets_recv": total.packets_recv,
        "interfaces": interfaces,
        "addresses": addrs,
    }


def _disk_info():
    """Physical disks and partitions."""
    partitions = []
    for p in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(p.mountpoint)
            io = psutil.disk_io_counters(perdisk=True).get(p.device.replace("/dev/", ""))
            partitions.append({
                "device": p.device,
                "mountpoint": p.mountpoint,
                "fstype": p.fstype,
                "opts": p.opts,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent,
                "read_bytes": io.read_bytes if io else 0,
                "write_bytes": io.write_bytes if io else 0,
            })
        except PermissionError:
            continue

    # Physical disk info via lsblk
    disks = []
    try:
        out = subprocess.check_output(
            ["lsblk", "-Jd", "-o", "NAME,SIZE,TYPE,MODEL,SERIAL,ROTA,TRAN"],
            text=True, timeout=5
        )
        blk = json.loads(out)
        for d in blk.get("blockdevices", []):
            if d.get("type") == "disk":
                disks.append({
                    "name": d.get("name", ""),
                    "size": d.get("size", ""),
                    "model": (d.get("model") or "Unknown").strip(),
                    "serial": (d.get("serial") or "N/A").strip(),
                    "type": "HDD" if d.get("rota") else "SSD/NVMe",
                    "transport": d.get("tran") or "N/A",
                })
    except Exception:
        pass

    # SMART health
    smart = {}
    for d in disks:
        dev_path = f"/dev/{d['name']}"
        try:
            out = subprocess.check_output(
                ["smartctl", "-H", "-j", dev_path],
                text=True, timeout=5, stderr=subprocess.DEVNULL
            )
            sj = json.loads(out)
            smart[d["name"]] = sj.get("smart_status", {}).get("passed", None)
        except Exception:
            smart[d["name"]] = None

    return {"partitions": partitions, "disks": disks, "smart": smart}


def _process_list():
    """Top processes by CPU usage."""
    procs = []
    # First call cpu_percent to prime the counter
    try:
        psutil.cpu_percent(interval=None)
    except Exception:
        pass
    for p in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_percent", "create_time"]):
        try:
            info = p.info
            procs.append({
                "pid": info["pid"],
                "name": info["name"],
                "user": info.get("username") or "N/A",
                "cpu": info.get("cpu_percent") or 0,
                "mem": round(info.get("memory_percent") or 0, 1),
                "started": datetime.fromtimestamp(info["create_time"]).strftime("%m-%d %H:%M") if info.get("create_time") else "",
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    procs.sort(key=lambda x: x["cpu"], reverse=True)
    return procs[:50]


def _system_info():
    """Basic system info."""
    boot = datetime.fromtimestamp(psutil.boot_time())
    uptime_sec = time.time() - psutil.boot_time()
    days = int(uptime_sec // 86400)
    hours = int((uptime_sec % 86400) // 3600)
    mins = int((uptime_sec % 3600) // 60)

    hostname = "Unknown"
    try:
        with open("/proc/sys/kernel/hostname") as f:
            hostname = f.read().strip()
    except Exception:
        pass

    kernel = "Unknown"
    try:
        import platform
        kernel = platform.release()
    except Exception:
        pass

    return {
        "hostname": hostname,
        "kernel": kernel,
        "boot_time": boot.strftime("%Y-%m-%d %H:%M:%S"),
        "uptime": f"{days}d {hours}h {mins}m",
    }


def _collect_all():
    """Collect all monitoring data."""
    return {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "system": _system_info(),
        "cpu": _cpu_info(),
        "memory": _memory_info(),
        "network": _network_info(),
        "disk": _disk_info(),
        "processes": _process_list(),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/data")
def api_data():
    try:
        return jsonify(_collect_all())
    except Exception as e:
        logger.error("Error collecting data: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/stream")
def api_stream():
    """SSE endpoint — pushes full data every 2 seconds."""
    def generate():
        while True:
            try:
                data = _collect_all()
                yield f"data: {json.dumps(data)}\n\n"
            except Exception as e:
                logger.error("Error in SSE stream: %s", e)
                yield f"data: {{\"error\": \"{str(e)}\"}}\n\n"
            time.sleep(2)
    return Response(generate(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/cpu")
def api_cpu():
    try:
        return jsonify(_cpu_info())
    except Exception as e:
        logger.error("Error getting CPU info: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/memory")
def api_memory():
    try:
        return jsonify(_memory_info())
    except Exception as e:
        logger.error("Error getting memory info: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/network")
def api_network():
    try:
        return jsonify(_network_info())
    except Exception as e:
        logger.error("Error getting network info: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/disk")
def api_disk():
    try:
        return jsonify(_disk_info())
    except Exception as e:
        logger.error("Error getting disk info: %s", e)
        return jsonify({"error": str(e)}), 500


@app.route("/api/processes")
def api_processes():
    try:
        return jsonify(_process_list())
    except Exception as e:
        logger.error("Error getting process list: %s", e)
        return jsonify({"error": str(e)}), 500


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # Allow configurable port
    port = int(__import__("os").environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
