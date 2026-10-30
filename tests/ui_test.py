"""端對端測試：邊緣偵測準確度、完整 UI 流程、PDF 產出"""
import base64
import json
import os
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
OUT.mkdir(parents=True, exist_ok=True)
SAMPLES = [ROOT / "tests" / "samples" / ("photo%d.jpg" % i) for i in (1, 2, 3)]

# 產生測試圖時使用的四角（1500x2000）
TRUTH = [
    [(210, 230), (1290, 180), (1370, 1830), (150, 1780)],
    [(300, 300), (1330, 240), (1420, 1760), (250, 1860)],
    [(180, 170), (1250, 300), (1310, 1820), (120, 1700)],
]
CW, CH = 1500, 2000


def b64(path):
    return base64.b64encode(path.read_bytes()).decode()


def main():
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(
            executable_path="/usr/bin/google-chrome",
            args=["--allow-file-access-from-files", "--no-sandbox"],
        )
        ctx = browser.new_context(viewport={"width": 1440, "height": 900},
                                  device_scale_factor=1)
        page = ctx.new_page()

        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append("console.%s: %s" % (m.type, m.text))
                if m.type == "error" else None)

        page.goto((ROOT / "index.html").as_uri())
        page.wait_for_timeout(500)
        page.screenshot(path=str(OUT / "01_empty.png"))

        # ---------- A. 影像管線 / 邊緣偵測 ----------
        payload = [b64(s) for s in SAMPLES]
        pipe = page.evaluate(
            """async (list) => {
                const out = [];
                for (const b64 of list) {
                    const bin = atob(b64);
                    const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    const blob = new Blob([arr], { type: 'image/jpeg' });
                    const src = await Pipeline.decode(blob, 1400);
                    const det = Pipeline.detect(src);
                    const quad = det.quad;
                    const t0 = performance.now();
                    const pageObj = {
                        quad: quad,
                        settings: Pipeline.defaultSettings(),
                        strokes: []
                    };
                    const out1 = Pipeline.render(src, pageObj, 1100);
                    const ms = performance.now() - t0;
                    const bw = Pipeline.render(src, Object.assign({}, pageObj,
                        { settings: Object.assign({}, pageObj.settings, { preset: 'bw' }) }), 700);
                    out.push({
                        srcW: src.width, srcH: src.height,
                        quad: quad,
                        renderMs: Math.round(ms),
                        outW: out1.width, outH: out1.height,
                        preview: out1.toDataURL('image/jpeg', 0.85),
                        bw: bw.toDataURL('image/jpeg', 0.85)
                    });
                }
                return out;
            }""", payload)

        report["detect"] = []
        for i, r in enumerate(pipe):
            truth = [{"x": x / CW, "y": y / CH} for (x, y) in TRUTH[i]]
            if r["quad"]:
                err = [((r["quad"][k]["x"] - truth[k]["x"]) ** 2 +
                        (r["quad"][k]["y"] - truth[k]["y"]) ** 2) ** 0.5 for k in range(4)]
                maxerr = max(err)
            else:
                maxerr = None
            report["detect"].append({
                "page": i + 1,
                "detected": r["quad"],
                "max_corner_err_norm": None if maxerr is None else round(maxerr, 4),
                "render_ms_1100px": r["renderMs"],
                "out": [r["outW"], r["outH"]],
            })
            for name, data in (("result%d" % (i + 1), r["preview"]), ("bw%d" % (i + 1), r["bw"])):
                with open(OUT / (name + ".jpg"), "wb") as f:
                    f.write(base64.b64decode(data.split(",", 1)[1]))

        # ---------- B. UI 流程 ----------
        page.set_input_files("#fileInput", [str(s) for s in SAMPLES])
        page.wait_for_function(
            "document.querySelectorAll('.card-img:not(.placeholder)').length === 3",
            timeout=60000,
        )
        page.wait_for_timeout(400)
        report["cards"] = page.eval_on_selector_all(".card", "els => els.length")
        page.screenshot(path=str(OUT / "02_grid.png"))

        # 開啟編輯器
        page.click(".card:nth-child(1) .card-img")
        page.wait_for_selector("#editor:not(.hidden)", timeout=10000)
        page.wait_for_timeout(1800)
        page.screenshot(path=str(OUT / "03_editor_crop.png"))

        # 自動偵測
        page.click("#btnAutoDetect")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "04_editor_detected.png"))

        # 效果預覽
        page.click("#btnToggleView")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(OUT / "05_editor_result.png"))

        # 換黑白濾鏡看看
        page.click(".chip[data-preset='bw']")
        page.wait_for_timeout(1800)
        page.screenshot(path=str(OUT / "06_editor_bw.png"))

        # 換回增強
        page.click(".chip[data-preset='auto']")
        page.wait_for_timeout(1500)

        # 套用
        page.click("#edApply")
        page.wait_for_timeout(4000)
        report["editor_closed"] = page.eval_on_selector("#editor", "el => el.classList.contains('hidden')")
        page.screenshot(path=str(OUT / "07_after_apply.png"))

        # ---------- C. 匯出 ----------
        page.evaluate("""() => {
            window.__blobs = [];
            const orig = URL.createObjectURL.bind(URL);
            URL.createObjectURL = function (b) { window.__blobs.push(b); return orig(b); };
        }""")

        page.click("#btnExport")
        page.wait_for_selector("#exportModal:not(.hidden)", timeout=5000)
        page.screenshot(path=str(OUT / "08_export.png"))
        page.select_option("#exQuality", "mid")
        page.click("#exGo")
        page.wait_for_function("window.__blobs && window.__blobs.length > 0", timeout=120000)
        page.wait_for_timeout(1500)

        pdf_b64 = page.evaluate("""async () => {
            const b = window.__blobs[window.__blobs.length - 1];
            const buf = await b.arrayBuffer();
            let s = '';
            const bytes = new Uint8Array(buf);
            for (let i = 0; i < bytes.length; i += 8192) {
                s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
            }
            return btoa(s);
        }""")
        (OUT / "out.pdf").write_bytes(base64.b64decode(pdf_b64))
        report["pdf_bytes"] = len(base64.b64decode(pdf_b64))

        # ---------- D. 手機視圖 ----------
        m = ctx.new_page()
        m.set_viewport_size({"width": 390, "height": 844})
        m.goto((ROOT / "index.html").as_uri())
        m.wait_for_timeout(400)
        m.screenshot(path=str(OUT / "09_mobile_empty.png"))
        m.set_input_files("#fileInput", [str(SAMPLES[0])])
        m.wait_for_function("document.querySelectorAll('.card-img:not(.placeholder)').length === 1",
                            timeout=60000)
        m.wait_for_timeout(300)
        m.screenshot(path=str(OUT / "10_mobile_grid.png"))
        m.click(".card:nth-child(1) .card-img")
        m.wait_for_timeout(2500)
        m.screenshot(path=str(OUT / "11_mobile_editor.png"))

        report["errors"] = errors
        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
