// 从 Google Fonts 拉取 Inter / Noto Sans SC 的可变字体子集，
// 生成 public/fonts/fonts.css 并把 woff2 落到 public/fonts/。
// dev 阶段本机装了字体时 @font-face 的 local() 直接命中，不需要跑这个脚本；
// build 前必须跑一次，否则没装字体的用户会拿到 404。
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve(import.meta.dirname, "../public/fonts");
// 伪装成新版 Chrome，Google 才会返回 woff2 而不是 ttf
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const FAMILIES = [
  {
    name: "Inter (variable)",
    cssUrl: "https://fonts.googleapis.com/css2?family=Inter:wght@100..900&display=swap",
    // dev 时本机 rsms Inter 注册的家族名，命中即不走网络
    locals: ["Inter var", "InterVariable", "Inter"],
  },
  {
    name: "Noto Sans SC (variable)",
    cssUrl: "https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@100..900&display=swap",
    locals: ["Noto Sans SC"],
  },
];

const BLOCK_RE = /@font-face\s*\{[^}]*\}/g;
const URL_RE = /url\((https:[^)]+\.woff2)\)/;

/** @param {string} url */
async function fetchOk(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  return res;
}

const files = new Map();
const parts = [
  "/* 由 scripts/fetch-fonts.mjs 生成，请勿手改。src: local() 优先，本机装了字体就不下载 woff2。 */",
];

for (const fam of FAMILIES) {
  const css = await (await fetchOk(fam.cssUrl)).text();
  const blocks = css.match(BLOCK_RE) ?? [];
  if (blocks.length === 0) throw new Error(`${fam.name}: 没解析到 @font-face，检查 CSS URL`);
  const localSrc = fam.locals.map((l) => `local('${l}')`).join(", ");
  for (const block of blocks) {
    const m = block.match(URL_RE);
    if (!m) continue;
    const fileName = path.basename(new URL(m[1]).pathname);
    files.set(fileName, m[1]);
    const rewritten = block.replace(/src:[^;]+;/, `src: ${localSrc}, url(/fonts/${fileName}) format('woff2');`);
    // Google 的 /* subset */ 注释保留在块前，方便排查
    parts.push(rewritten);
  }
  console.log(`${fam.name}: ${blocks.length} 个 @font-face`);
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, "fonts.css"), parts.join("\n") + "\n", "utf8");

let totalBytes = 0;
for (const [fileName, url] of files) {
  const buf = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  totalBytes += buf.length;
  await writeFile(path.join(OUT_DIR, fileName), buf);
}
console.log(`已下载 ${files.size} 个 woff2（${(totalBytes / 1024 / 1024).toFixed(1)} MB）到 public/fonts/`);
