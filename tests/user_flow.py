"""用使用者的照片跑一次完整 UI 流程，確認提示與輸出"""
import pathlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
SRC = ROOT / "tests" / "samples" / "user_src.jpg"

with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    pg = b.new_page(viewport={"width": 1440, "height": 900})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto((ROOT / "index.html").as_uri())
    pg.wait_for_timeout(400)
    pg.set_input_files("#fileInput", [str(SRC)])
    pg.wait_for_selector(".card-img:not(.placeholder)", timeout=30000)
    pg.screenshot(path=str(OUT / "u1_grid.png"))

    pg.click(".card")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "u2_editor.png"))
    hint = pg.inner_text("#stageHint")

    pg.click("#btnToggleView")
    pg.wait_for_timeout(2500)
    pg.screenshot(path=str(OUT / "u3_result.png"))
    print("hint:", hint, "errors:", errs)
    b.close()
