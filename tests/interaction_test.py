"""互動測試：修補筆刷、旋轉、全部套用預設"""
import json
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
SAMPLES = [ROOT / "tests" / "samples" / ("photo%d.jpg" % i) for i in (1, 2, 3)]


def main():
    report = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path="/usr/bin/google-chrome",
                                    args=["--no-sandbox"])
        ctx = browser.new_context(viewport={"width": 1440, "height": 900})
        page = ctx.new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(str(e)))

        page.goto((ROOT / "index.html").as_uri())
        page.set_input_files("#fileInput", [str(s) for s in SAMPLES])
        page.wait_for_function(
            "document.querySelectorAll('.card-img:not(.placeholder)').length === 3",
            timeout=60000)

        page.click(".card:nth-child(1) .card-img")
        page.wait_for_selector("#editor:not(.hidden)")
        page.wait_for_timeout(1500)
        page.screenshot(path=str(OUT / "12_before_brush.png"))

        # 切到效果預覽 + 開筆刷
        page.click("#btnToggleView")
        page.wait_for_timeout(1800)
        page.evaluate("() => document.querySelector('#chkBrush').parentElement.click()")
        page.wait_for_timeout(1500)

        box = page.locator("#edOverlay").bounding_box()
        # 塗抹印章位置（右下角）
        x0 = box["x"] + box["width"] * 0.60
        x1 = box["x"] + box["width"] * 0.88
        y = box["y"] + box["height"] * 0.90
        page.mouse.move(x0, y)
        page.mouse.down()
        steps = 14
        for i in range(1, steps + 1):
            page.mouse.move(x0 + (x1 - x0) * i / steps, y + (i % 2) * 2, steps=1)
        page.mouse.up()
        page.wait_for_timeout(2500)
        page.screenshot(path=str(OUT / "13_after_brush.png"))
        report["strokes"] = page.evaluate("() => window.__strokeCount || 'n/a'")

        # 旋轉
        page.evaluate("() => document.querySelector('#chkBrush').parentElement.click()")
        page.wait_for_timeout(500)
        page.click("#btnRotR")
        page.wait_for_timeout(2000)
        page.screenshot(path=str(OUT / "14_rotated.png"))
        report["rot_label"] = page.inner_text("#rotLabel")
        page.click("#btnRotL")
        page.wait_for_timeout(1200)

        # 套用
        page.click("#edApply")
        page.wait_for_timeout(4500)
        page.screenshot(path=str(OUT / "15_applied.png"))

        # 全部套用預設
        page.click("#btnApplyAll")
        page.wait_for_timeout(6000)
        page.screenshot(path=str(OUT / "16_apply_all.png"))
        report["thumbs"] = page.eval_on_selector_all(
            ".card-img", "els => els.filter(e => e.style.backgroundImage).length")
        report["errors"] = errs
        browser.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
