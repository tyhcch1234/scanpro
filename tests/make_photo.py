"""產生模擬的「手機拍攝文件」測試相片：
桌面背景 + 透視變形 + 光線不均 + 雜訊
"""
import math
import random
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W_DOC, H_DOC = 1240, 1754
random.seed(7)


def find_font(size):
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
    ]
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_document(idx):
    img = Image.new("RGB", (W_DOC, H_DOC), (252, 250, 246))
    d = ImageDraw.Draw(img)
    f_title = find_font(42)
    f_body = find_font(24)
    f_small = find_font(19)

    d.rectangle([70, 70, W_DOC - 70, 160], fill=(20, 40, 90))
    d.text((95, 92), "SCAN TEST DOCUMENT #%d" % idx, font=f_title, fill=(255, 255, 255))

    y = 220
    for i in range(28):
        w = random.randint(int(W_DOC * 0.4), int(W_DOC * 0.82))
        d.rectangle([95, y, 95 + w, y + 11], fill=(30, 30, 34))
        y += 44
        if i % 7 == 6:
            y += 18

    # 表格
    ty = y + 10
    for r in range(5):
        for c in range(4):
            x0 = 95 + c * 265
            d.rectangle([x0, ty + r * 54, x0 + 265, ty + r * 54 + 54],
                        outline=(60, 60, 60), width=2)
            d.rectangle([x0 + 14, ty + r * 54 + 18, x0 + 14 + random.randint(60, 200),
                         ty + r * 54 + 30], fill=(70, 70, 74))

    # 印章
    sx, sy = W_DOC - 330, H_DOC - 320
    d.ellipse([sx, sy, sx + 230, sy + 230], outline=(190, 40, 40), width=8)
    d.text((sx + 40, sy + 90), "APPROVED", font=f_small, fill=(190, 40, 40))

    d.text((95, H_DOC - 120), "Page %d — generated for pipeline verification" % idx,
           font=f_small, fill=(80, 80, 84))
    return img


def make_desk(w, h):
    bg = Image.new("RGB", (w, h))
    px = bg.load()
    base = (96, 74, 56)
    for y in range(h):
        for x in range(0, w, 4):
            n = random.randint(-16, 16)
            c = (max(0, min(255, base[0] + n)),
                 max(0, min(255, base[1] + n)),
                 max(0, min(255, base[2] + n)))
            for k in range(4):
                if x + k < w:
                    px[x + k, y] = c
    bg = bg.filter(ImageFilter.GaussianBlur(1.2))
    d = ImageDraw.Draw(bg)
    for i in range(160):
        x = random.randint(0, w)
        d.line([(x, 0), (x + random.randint(-30, 30), h)],
               fill=(random.randint(70, 110), random.randint(55, 85), random.randint(40, 65)), width=1)
    return bg


def homography(src_pts, dst_pts):
    """回傳把 dst -> src 的 8 個係數（PIL PERSPECTIVE 格式）"""
    A, b = [], []
    for (x, y), (u, v) in zip(src_pts, dst_pts):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.append(u)
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y]); b.append(v)
    n = 8
    for i in range(1, n):
        piv = i - 1
        for r in range(i, n):
            if abs(A[r][i - 1]) > abs(A[piv][i - 1]):
                piv = r
        A[piv], A[i - 1] = A[i - 1], A[piv]
        b[piv], b[i - 1] = b[i - 1], b[piv]
        for r in range(i, n):
            f = A[r][i - 1] / A[i - 1][i - 1]
            for c in range(i - 1, n):
                A[r][c] -= f * A[i - 1][c]
            b[r] -= f * b[i - 1]
    x = [0] * n
    for i in range(n - 1, -1, -1):
        s = b[i]
        for c in range(i + 1, n):
            s -= A[i][c] * x[c]
        x[i] = s / A[i][i]
    return x


def build(idx, CW=1500, CH=2000, quad=None):
    doc = make_document(idx)
    desk = make_desk(CW, CH)

    if quad is None:
        quad = [(210, 230), (1290, 180), (1370, 1830), (150, 1780)]

    coeffs = homography(quad, [(0, 0), (W_DOC, 0), (W_DOC, H_DOC), (0, H_DOC)])
    warped = doc.transform((CW, CH), Image.PERSPECTIVE, coeffs, Image.BICUBIC)

    mask = Image.new("L", (CW, CH), 0)
    ImageDraw.Draw(mask).polygon(quad, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(1.0))

    out = Image.composite(warped, desk, mask)

    # 光線不均：左上亮、右下暗 + 局部手影
    shade = Image.new("L", (CW, CH))
    sp = shade.load()
    for y in range(CH):
        for x in range(0, CW, 3):
            v = 255 - int(120 * ((x / CW) ** 1.6 + (y / CH) ** 1.4) / 2)
            for k in range(3):
                if x + k < CW:
                    sp[x + k, y] = max(40, v)
    # 用 multiply 方式壓上陰影（模擬側光 / 手影）
    mul = out.copy()
    m = mul.load()
    s = shade.load()
    for y in range(CH):
        for x in range(CW):
            r, g, b = m[x, y]
            k = s[x, y] / 255.0
            m[x, y] = (int(r * k), int(g * k), int(b * k))

    # 雜訊
    n = mul.load()
    for y in range(0, CH, 2):
        for x in range(0, CW, 2):
            dv = random.randint(-5, 5)
            r, g, b = n[x, y]
            n[x, y] = (max(0, min(255, r + dv)), max(0, min(255, g + dv)), max(0, min(255, b + dv)))

    return mul


if __name__ == "__main__":
    quads = [
        [(210, 230), (1290, 180), (1370, 1830), (150, 1780)],
        [(300, 300), (1330, 240), (1420, 1760), (250, 1860)],
        [(180, 170), (1250, 300), (1310, 1820), (120, 1700)],
    ]
    for i, q in enumerate(quads, start=1):
        img = build(i, quad=q)
        img.save("tests/samples/photo%d.jpg" % i, quality=88)
        print("wrote photo%d.jpg" % i)
