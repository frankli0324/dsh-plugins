import { readFile } from "node:fs/promises";

export const name = 'dsh-mobile-ui'

const TOUCH_ICON_URL = new URL('./apple-touch-icon.png', import.meta.url)

// Foldable-posture diagnostic page, served at /dsh-mobile-ui/posture.html.
// Temporary developer aid: reports Device Posture / Viewport Segments state on
// the device itself. The embedded script must stay free of backticks and ${.
const POSTURE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>折叠姿态诊断</title>
<style>
  body{font:15px/1.6 -apple-system,sans-serif;margin:0;padding:12px 14px 40px;background:#111;color:#eee}
  h1{font-size:17px;margin:4px 0 10px}
  .row{display:flex;justify-content:space-between;gap:10px;padding:7px 10px;border-radius:8px;background:#1c1c1e;margin:5px 0}
  .row b{font-weight:600;color:#9ad}
  .ok{color:#6f6;font-weight:700}
  .no{color:#f66;font-weight:700}
  .hint{color:#888;font-size:13px;margin:10px 2px}
</style>
</head>
<body>
<h1>折叠姿态诊断（折叠后看这里的读数）</h1>
<div class="hint">把手机折成 laptop 姿态，观察下面每一行的变化。folded / 匹配 = 生效。</div>
<div id="list"></div>
<script>
  var probes = [
    ["viewport-segment-height 0 0", "env(viewport-segment-height 0 0, 12345px)"],
    ["viewport-segment-top 0 1", "env(viewport-segment-top 0 1, 12345px)"],
    ["viewport-segment-height 1 0", "env(viewport-segment-height 1 0, 12345px)"]
  ];
  var probeEls = probes.map(function () {
    var el = document.createElement("div");
    el.style.cssText = "position:fixed;visibility:hidden;height:0;overflow:hidden";
    document.body.appendChild(el);
    return el;
  });
  var mqs = [
    ["(device-posture)", "支持 device-posture 媒体特性"],
    ["(device-posture: folded)", "folded（半折，新值）"],
    ["(device-posture: booked)", "booked（半折，旧值）"],
    ["(vertical-viewport-segments: 2)", "上下两段（laptop 姿态）"],
    ["(horizontal-viewport-segments: 2)", "左右两段（书本姿态）"]
  ];
  var mqEls = mqs.map(function (m) { return window.matchMedia(m[0]); });
  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;"); }
  function render() {
    var rows = [];
    rows.push(["navigator.devicePosture", navigator.devicePosture ? navigator.devicePosture.type : "不可用（flag 未开 / 安全上下文受限）"]);
    rows.push(["window.viewport.segments", window.viewport && Array.isArray(window.viewport.segments) ? window.viewport.segments.map(function (s) { return Math.round(s.width) + "x" + Math.round(s.height); }).join(" , ") : "不可用"]);
    rows.push(["innerWidth x innerHeight", window.innerWidth + " x " + window.innerHeight]);
    mqs.forEach(function (m, i) { rows.push([m[1], mqEls[i].matches ? "MATCH" : "不匹配"]); });
    probes.forEach(function (p, i) {
      probeEls[i].style.width = p[1];
      var w = probeEls[i].getBoundingClientRect().width;
      rows.push(["env(" + p[0] + ")", Math.abs(w - 12345) < 0.5 ? "无效" : Math.round(w) + "px"]);
    });
    document.getElementById("list").innerHTML = rows.map(function (r) {
      var good = r[1] === "MATCH" || r[1] === "folded" || r[1] === "booked";
      return '<div class="row"><b>' + esc(r[0]) + '</b><span class="' + (good ? "ok" : "no") + '">' + esc(r[1]) + "</span></div>";
    }).join("");
  }
  function update() { render(); }
  if (navigator.devicePosture) navigator.devicePosture.addEventListener("change", update);
  window.addEventListener("resize", update);
  window.addEventListener("orientationchange", update);
  setInterval(update, 1000);
  update();
</script>
</body>
</html>
`

export function apply(ctx) {
	ctx.inject(['webServer'], (web) => {
		web.effect(() => web.webServer.register({
			kind: 'exact',
			path: '/apple-touch-icon.png',
			handler: async (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405)
					res.end()
					return
				}
				let body
				try {
					body = await readFile(TOUCH_ICON_URL)
				} catch {
					// The handler owns the full response lifecycle; a missing icon must
					// 404 rather than hang the socket and reject unhandled.
					res.writeHead(404)
					res.end()
					return
				}
				res.writeHead(200, {
					'content-type': 'image/png',
					'content-length': String(body.length),
					'cache-control': 'public, max-age=86400'
				})
				res.end(req.method === 'HEAD' ? undefined : body)
			}
		}), 'dsh-mobile-ui: apple touch icon route')
		web.effect(() => web.webServer.register({
			kind: 'exact',
			path: '/dsh-mobile-ui/posture.html',
			handler: async (req, res) => {
				if (req.method !== 'GET' && req.method !== 'HEAD') {
					res.writeHead(405)
					res.end()
					return
				}
				const body = Buffer.from(POSTURE_HTML, 'utf8')
				res.writeHead(200, {
					'content-type': 'text/html; charset=utf-8',
					'content-length': String(body.length),
					'cache-control': 'no-store'
				})
				res.end(req.method === 'HEAD' ? undefined : body)
			}
		}), 'dsh-mobile-ui: posture debug route')
	})
}
