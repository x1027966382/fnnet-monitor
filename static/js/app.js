/* FNNet Monitor — frontend JS */
(function () {
    "use strict";

    // ── Helpers ──────────────────────────────────────────────────────
    function escapeHtml(str) {
        if (str == null) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }
    function fmtBytes(b) {
        if (b === 0) return "0 B";
        var u = ["B", "KB", "MB", "GB", "TB"];
        var i = Math.floor(Math.log(b) / Math.log(1024));
        return (b / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + " " + u[i];
    }
    function fmtSpeed(b) { return fmtBytes(b) + "/s"; }

    // ── Gauge draw ───────────────────────────────────────────────────
    function drawGauge(canvasId, pct, color) {
        var c = document.getElementById(canvasId);
        if (!c) return;
        var ctx = c.getContext("2d");
        var w = c.width, h = c.height, cx = w / 2, cy = h / 2, r = (w - 12) / 2;
        ctx.clearRect(0, 0, w, h);
        // bg arc
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = "#2a2d3a";
        ctx.lineWidth = 10;
        ctx.stroke();
        // value arc
        var angle = (pct / 100) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + angle);
        ctx.strokeStyle = color;
        ctx.lineWidth = 10;
        ctx.lineCap = "round";
        ctx.stroke();
    }
    function pctColor(p) {
        if (p > 80) return "#ef4444";
        if (p > 60) return "#f97316";
        if (p > 40) return "#eab308";
        return "#22c55e";
    }

    // ── Network chart ────────────────────────────────────────────────
    var netHistory = { up: [], down: [], max: 60 };
    var netCanvas = document.getElementById("netChart");
    function drawNetChart() {
        if (!netCanvas) return;
        var ctx = netCanvas.getContext("2d");
        var w = netCanvas.width = netCanvas.offsetWidth;
        var h = netCanvas.height = 100;
        ctx.clearRect(0, 0, w, h);
        var all = netHistory.up.concat(netHistory.down);
        var maxVal = Math.max.apply(null, all) || 1;
        var len = Math.max(netHistory.up.length, netHistory.down.length, 1);
        var step = w / (netHistory.max - 1);

        function drawLine(data, color) {
            if (data.length < 2) return;
            ctx.beginPath();
            for (var i = 0; i < data.length; i++) {
                var x = (netHistory.max - data.length + i) * step;
                var y = h - (data[i] / maxVal) * (h - 10) - 5;
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            }
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        drawLine(netHistory.down, "#3b82f6");
        drawLine(netHistory.up, "#22c55e");
    }

    // ── Color bar for disk ───────────────────────────────────────────
    function partColor(pct) {
        if (pct > 90) return "#ef4444";
        if (pct > 75) return "#f97316";
        if (pct > 50) return "#eab308";
        return "#22c55e";
    }

    // ── Process CPU badge ────────────────────────────────────────────
    function cpuBadge(pct) {
        var cls = "low";
        if (pct > 50) cls = "high";
        else if (pct > 20) cls = "mid";
        return '<span class="cpu-badge ' + cls + '">' + pct.toFixed(1) + '</span>';
    }

    // ── Core color ───────────────────────────────────────────────────
    function coreColor(pct) {
        if (pct > 80) return "rgba(239,68,68,.8)";
        if (pct > 50) return "rgba(249,115,22,.8)";
        if (pct > 20) return "rgba(234,179,8,.7)";
        return "rgba(34,197,94,.5)";
    }

    // ── Update DOM ───────────────────────────────────────────────────
    function update(d) {
        // Header
        var sys = d.system || {};
        document.getElementById("hostname").textContent = sys.hostname || "—";
        document.getElementById("uptime").textContent = "⏱ " + (sys.uptime || "—");
        document.getElementById("kernel").textContent = sys.kernel || "—";
        document.getElementById("lastUpdate").textContent = d.timestamp || "";

        // CPU
        var cpu = d.cpu || {};
        var cpuP = cpu.usage_total || 0;
        document.getElementById("cpuPercent").textContent = cpuP.toFixed(1) + "%";
        drawGauge("cpuGauge", cpuP, pctColor(cpuP));
        document.getElementById("cpuModel").textContent = cpu.model || "—";
        document.getElementById("cpuCores").textContent = (cpu.physical_cores || 0) + " / " + (cpu.logical_cores || 0);
        var la = cpu.load_avg || {};
        document.getElementById("cpuLoad").textContent = [la["1m"], la["5m"], la["15m"]].join(" / ");

        // CPU temp
        var tempHtml = "";
        var temps = cpu.temperatures || {};
        for (var tk in temps) {
            temps[tk].forEach(function (t) {
                var val = t.current != null ? t.current.toFixed(1) + "°C" : "N/A";
                tempHtml += '<span class="temp-badge">🌡 ' + escapeHtml(t.label || tk) + ": " + val + "</span>";
            });
        }
        document.getElementById("cpuTemp").innerHTML = tempHtml;

        // Per-core bars
        var cores = cpu.usage_per_core || [];
        var coresHtml = "";
        cores.forEach(function (u, i) {
            coresHtml += '<div class="core-bar" style="background:' + coreColor(u) + '" data-tip="Core ' + i + ": " + u.toFixed(1) + '%"></div>';
        });
        document.getElementById("cpuPerCore").innerHTML = coresHtml;

        // Memory
        var mem = d.memory || {};
        var memP = mem.percent || 0;
        document.getElementById("memPercent").textContent = memP.toFixed(1) + "%";
        drawGauge("memGauge", memP, pctColor(memP));
        document.getElementById("memTotal").textContent = fmtBytes(mem.total || 0);
        document.getElementById("memUsed").textContent = fmtBytes(mem.used || 0);
        document.getElementById("memAvail").textContent = fmtBytes(mem.available || 0);
        document.getElementById("memCached").textContent = fmtBytes(mem.cached || 0);
        document.getElementById("memSwap").textContent = fmtBytes(mem.swap_used || 0) + " / " + fmtBytes(mem.swap_total || 0) + " (" + (mem.swap_percent || 0).toFixed(1) + "%)";

        // Network — remove initial zero display to avoid flicker
        var ifaces = net.interfaces || {};
        var totalUp = 0, totalDown = 0;
        for (var nic in ifaces) {
            if (nic.indexOf("lo") === 0) continue;
            totalUp += ifaces[nic].speed_sent || 0;
            totalDown += ifaces[nic].speed_recv || 0;
        }
        document.getElementById("netUp").textContent = fmtSpeed(totalUp);
        document.getElementById("netDown").textContent = fmtSpeed(totalDown);
        document.getElementById("netTotalSent").textContent = fmtBytes(net.total_sent || 0);
        document.getElementById("netTotalRecv").textContent = fmtBytes(net.total_recv || 0);

        netHistory.up.push(totalUp);
        netHistory.down.push(totalDown);
        if (netHistory.up.length > netHistory.max) netHistory.up.shift();
        if (netHistory.down.length > netHistory.max) netHistory.down.shift();
        drawNetChart();

        // Net interfaces
        var nicHtml = "";
        for (var n in ifaces) {
            if (n.indexOf("lo") === 0) continue;
            nicHtml += '<div class="iface-item">';
            nicHtml += '<div class="iface-name">' + escapeHtml(n) + "</div>";
            nicHtml += '<div>↑ ' + fmtSpeed(ifaces[n].speed_sent) + " &nbsp; ↓ " + fmtSpeed(ifaces[n].speed_recv) + "</div>";
            nicHtml += "</div>";
        }
        document.getElementById("netInterfaces").innerHTML = nicHtml;

        // Disk
        var disk = d.disk || {};
        var disksHtml = "";
        (disk.disks || []).forEach(function (dk) {
            var smartText = dk.name in (disk.smart || {}) ? (disk.smart[dk.name] === true ? "✅ 健康" : disk.smart[dk.name] === false ? "⚠️ 警告" : "❓ 未知") : "";
            disksHtml += '<div class="disk-item">';
            disksHtml += '<div class="disk-name">💿 ' + escapeHtml(dk.name) + " — " + escapeHtml(dk.model) + "</div>";
            disksHtml += '<div class="disk-meta">' + escapeHtml(dk.type) + " | " + escapeHtml(dk.size) + " | " + escapeHtml(dk.transport) + " | " + smartText + "</div>";
            disksHtml += "</div>";
        });
        document.getElementById("diskPhysical").innerHTML = disksHtml;

        var partHtml = "";
        (disk.partitions || []).forEach(function (p) {
            var col = partColor(p.percent);
            partHtml += '<div class="part-row">';
            partHtml += '<div class="info-row"><span>' + escapeHtml(p.mountpoint) + " (" + escapeHtml(p.device) + ')</span><span>' + fmtBytes(p.used) + " / " + fmtBytes(p.total) + " (" + p.percent.toFixed(1) + "%)</span></div>";
            partHtml += '<div class="part-bar-bg"><div class="part-bar" style="width:' + p.percent + "%;background:" + col + '"></div></div>';
            partHtml += "</div>";
        });
        document.getElementById("diskPartitions").innerHTML = partHtml;

        // Processes
        var procs = d.processes || [];
        var procHtml = "";
        procs.slice(0, 20).forEach(function (p) {
            procHtml += "<tr>";
            procHtml += "<td>" + escapeHtml(String(p.pid)) + "</td>";
            procHtml += "<td>" + escapeHtml(p.name) + "</td>";
            procHtml += "<td>" + escapeHtml(p.user) + "</td>";
            procHtml += "<td>" + cpuBadge(p.cpu) + "</td>";
            procHtml += "<td>" + p.mem.toFixed(1) + "</td>";
            procHtml += "<td>" + escapeHtml(p.started) + "</td>";
            procHtml += "</tr>";
        });
        document.getElementById("procList").innerHTML = procHtml;

        // Status dot
        document.getElementById("statusDot").classList.add("ok");
    }

    // ── SSE connect ──────────────────────────────────────────────────
    function connect() {
        var es = new EventSource("/api/stream");
        es.onmessage = function (e) {
            try {
                var d = JSON.parse(e.data);
                update(d);
            } catch (err) {
                console.error("SSE parse error", err);
            }
        };
        es.onerror = function () {
            document.getElementById("statusDot").classList.remove("ok");
            document.getElementById("lastUpdate").textContent = "连接断开，重连中...";
        };
    }

    // ── Init ─────────────────────────────────────────────────────────
    connect();
})();
