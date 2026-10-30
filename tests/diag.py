"""診斷：把使用者照片跑過管線，輸出各階段影像與數據"""
import base64
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
SRC = ROOT / "tests" / "samples" / (sys.argv[1] if len(sys.argv) > 1 else "user_src.jpg")

JS = """
async (b64) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'image/jpeg' });
  const src = await Pipeline.decode(blob, 1400);

  const det = Pipeline.detect(src);
  const quad = det.quad;
  const res = { srcSize: [src.width, src.height], auto: det.auto, quad: quad };

  const dump = (canvas) => canvas.toDataURL('image/jpeg', 0.9);
  res.srcImg = dump(src);

  function withQuad(quad) {
    const page = { quad: quad, settings: Pipeline.defaultSettings(), strokes: [] };
    const warped = CV.warp(src, quad, 1400);
    res.warpSize = [warped.width, warped.height];
    res.warped = dump(warped);
    const out = Pipeline.render(src, page, 1400);
    res.finalSize = [out.width, out.height];
    res.final = dump(out);
    return out;
  }
  withQuad(quad);

  // 逐階段
  const s = Pipeline.defaultSettings();
  let c = CV.warp(src, quad, 1400);
  res.stage_warp = dump(c);
  c = CV.trimBorders(c);
  res.stage_trim = dump(c);
  res.trimSize = [c.width, c.height];
  c = Filters.apply(c, s);
  res.stage_filter = dump(c);
  return res;
}
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    b64 = base64.b64encode(SRC.read_bytes()).decode()
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page()
        pg.goto((ROOT / "index.html").as_uri())
        res = pg.evaluate(JS, b64)
        b.close()

    def save(key, name):
        if key not in res:
            return
        data = res[key].split(",")[1]
        (OUT / name).write_bytes(base64.b64decode(data))

    for k, n in [("srcImg", "d_src.jpg"), ("warped", "d_warped.jpg"), ("final", "d_final.jpg"),
                 ("stage_warp", "d_stage_warp.jpg"), ("stage_trim", "d_stage_trim.jpg")]:
        save(k, n)

    brief = {k: v for k, v in res.items() if not isinstance(v, str)}
    print(json.dumps(brief, indent=1))


if __name__ == "__main__":
    main()
