"""用指定的四角渲染，隔離「裁切」與「色調」問題"""
import base64
import json
import pathlib
import sys

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tests" / "out"
OUT.mkdir(parents=True, exist_ok=True)

QUADS = {
    "user": [[0.190, 0.092], [0.850, 0.071], [0.972, 0.908], [0.100, 0.938]],
}

JS = """
async ([b64, quad, settings]) => {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const blob = new Blob([arr], { type: 'image/jpeg' });
  const src = await Pipeline.decode(blob, 1400);
  const page = { quad: quad.map(p => ({ x: p[0], y: p[1] })), settings: settings, strokes: [] };
  const out = Pipeline.render(src, page, 1400);

  // 各階段
  const dump = (c) => c.toDataURL('image/jpeg', 0.92);
  const stages = {};
  let c = CV.warp(src, page.quad, 1400);
  stages.warp = dump(c);
  c = CV.trimBorders(c);
  stages.trim = dump(c);
  const s = Object.assign({}, settings);
  const noShadow = Filters.apply(c, Object.assign({}, s, { shadow: 0 }));
  stages.noshadow = dump(noShadow);
  const shadowOnly = Filters.apply(c, Object.assign({}, Filters.DEFAULTS, { preset: 'original' }));
  stages.shadowonly = dump(shadowOnly);
  stages.final = dump(out);
  return { stages, size: [out.width, out.height] };
}
"""


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else "user"
    src = ROOT / "tests" / "samples" / "user_src.jpg"
    b64 = base64.b64encode(src.read_bytes()).decode()
    settings = {"preset": "auto", "shadow": 95, "sharpen": 40, "contrast": 0,
                "brightness": 0, "denoise": False, "moire": False,
                "rotate": 0, "fine": 0, "bend": 0}
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
        pg = b.new_page()
        pg.goto((ROOT / "index.html").as_uri())
        res = pg.evaluate(JS, [b64, QUADS[name], settings])
        b.close()
    for k, v in res["stages"].items():
        (OUT / ("q_%s_%s.jpg" % (name, k))).write_bytes(base64.b64decode(v.split(",")[1]))
    print(json.dumps(res["size"]))


if __name__ == "__main__":
    main()
