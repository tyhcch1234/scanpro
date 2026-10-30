"""把 css/js 內嵌，產出可直接分享的單檔版本 scanpro-single.html"""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent
html = (ROOT / "index.html").read_text(encoding="utf-8")

css = (ROOT / "css" / "style.css").read_text(encoding="utf-8")
html = html.replace('<link rel="stylesheet" href="css/style.css">',
                    "<style>\n" + css + "\n</style>")

for src in re.findall(r'<script src="([^"]+)"></script>', html):
    code = (ROOT / src).read_text(encoding="utf-8")
    html = html.replace('<script src="%s"></script>' % src,
                        "<script>\n" + code + "\n</script>")

targets = [ROOT / "single.html", ROOT.parent / "scanpro-single.html"]
for out in targets:
    out.write_text(html, encoding="utf-8")
    print("wrote", out, len(html), "chars")
