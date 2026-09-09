# Assets

| File | What it is |
|------|-----------|
| `logo.jpg`, `banner.jpg` | the originals you dropped in (red on white, JPEG) |
| `logo-mark.png`, `banner-mark.png` | **used by the page** — same artwork with the white background stripped to transparency and the margins trimmed |
| `stonk-screen.png` | the exhibit in *The gap* — StonkFun's importer refusing an ownership coin as a quote token |

The `-mark.png` files are generated from the JPEGs. If you replace a JPEG, regenerate
its mark (or just save a transparent PNG over the `-mark.png` file directly).

`index.html` falls back to a CSS brush wordmark if a mark file is missing, so the page
never breaks.
