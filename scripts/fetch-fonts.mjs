// 拉取正文默认字体到 public/fonts/ 并生成 fonts.css：
// Inter 用 rsms.me 官方的 InterVariable（cv02和cv11 变体在 style.css 里经 font-feature-settings 开启），
// Noto Sans SC 走 Google Fonts 的 unicode-range 子集。
// dev 阶段本机装了字体时 @font-face 的 local() 直接命中，不需要跑这个脚本；
// build 前必须跑一次，否则没装字体的用户会拿到 404。
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const OUT_DIR = path.resolve(import.meta.dirname, "../public/fonts");
// 伪装成新版 Chrome，Google 才会返回 woff2 而不是 ttf
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Inter 直接从 rsms.me 取官方可变字体；local() 对应本机安装的 rsms Inter
const INTER_FACES = [
  {
    fileName: "InterVariable.woff2",
    url: "https://rsms.me/inter/font-files/InterVariable.woff2",
    style: "normal",
    locals: ["Inter var", "InterVariable"],
  },
  {
    fileName: "InterVariable-Italic.woff2",
    url: "https://rsms.me/inter/font-files/InterVariable-Italic.woff2",
    style: "italic",
    locals: ["Inter var Italic", "InterVariable-Italic", "Inter var"],
  },
];

const FAMILIES = [
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

// Inter：rsms.me 官方可变字体，家族名与栈里的 "Inter var" 一致，一个文件覆盖全部字重/宽度
for (const face of INTER_FACES) {
  const localSrc = face.locals.map((l) => `local('${l}')`).join(", ");
  files.set(face.fileName, face.url);
  parts.push(`@font-face {
  font-family: 'Inter var';
  font-style: ${face.style};
  font-weight: 100 900;
  font-display: swap;
  src: ${localSrc}, url(/fonts/${face.fileName}) format('woff2');
}`);
}

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

// 清掉上次抓取遗留、本次已不引用的 woff2（比如换成 rsms 版后 Google 的分片文件）
const referenced = new Set(files.keys());
for (const entry of await readdir(OUT_DIR)) {
  if (entry.endsWith(".woff2") && !referenced.has(entry)) {
    await rm(path.join(OUT_DIR, entry));
    console.log(`已删除过期文件 ${entry}`);
  }
}

let totalBytes = 0;
for (const [fileName, url] of files) {
  const buf = Buffer.from(await (await fetchOk(url)).arrayBuffer());
  totalBytes += buf.length;
  await writeFile(path.join(OUT_DIR, fileName), buf);
}
console.log(`已下载 ${files.size} 个 woff2（${(totalBytes / 1024 / 1024).toFixed(1)} MB）到 public/fonts/`);
