#!/usr/bin/env node
/**
 * Bing 每日壁纸抓取脚本（无第三方依赖，Node 18+）
 *
 * 功能：
 *   1. 调用 Bing HPImageArchive 接口获取壁纸元数据
 *   2. 下载指定分辨率的图片到 wallpapers/ 目录（已存在则跳过）
 *   3. 更新 data/wallpapers.json 元数据（按日期倒序）
 *
 * 环境变量：
 *   MARKETS     逗号分隔的地区列表，默认 "zh-CN"
 *   DAYS        抓取的天数（1-16），默认 "8"
 *   MAX_KEEP    最多保留的壁纸条数，超出则裁剪（0=不裁剪），默认 "0"
 *
 * 用法：
 *   node scripts/update.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'wallpapers.json');
const WALLPAPER_DIR = path.join(ROOT, 'wallpapers');

const MARKETS = (process.env.MARKETS || 'zh-CN').split(',').map(s => s.trim()).filter(Boolean);
const DAYS = Math.min(16, Math.max(1, parseInt(process.env.DAYS || '8', 10)));
const MAX_KEEP = parseInt(process.env.MAX_KEEP || '0', 10);

// 需要下载的分辨率：key 为语义化名称，suffix 为 Bing URL 后缀
const RESOLUTIONS = [
  { key: 'thumb', suffix: '1280x720' },   // 瀑布流缩略图
  { key: 'full',  suffix: '1920x1080' },  // 全高清预览/下载
  { key: 'uhd',   suffix: 'UHD' },        // 超高清下载
];

const BING = 'https://www.bing.com';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === retries - 1) throw err;
      console.warn(`  请求失败(${err.message})，重试 ${i + 1}/${retries}...`);
      await sleep(1500);
    }
  }
}

async function downloadFile(url, dest, retries = 3) {
  if (fs.existsSync(dest)) return false; // 已存在，跳过
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length < 1024) throw new Error('文件过小，可能无效');
      fs.writeFileSync(dest, buffer);
      return true;
    } catch (err) {
      if (i === retries - 1) throw err;
      await sleep(1500);
    }
  }
}

// 从 urlbase 中提取壁纸唯一 ID，例如 OHR.NavajoNation_ZH-CN9274387505 -> NavajoNation_ZH-CN9274387505
function extractId(urlbase) {
  const m = urlbase.match(/OHR\.([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

function formatDate(s) {
  // "20260730" -> "2026-07-30"
  return s.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
}

function loadExisting() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

async function processMarket(mkt, existingKeys) {
  const url = `${BING}/HPImageArchive.aspx?format=js&idx=0&n=${DAYS}&mkt=${mkt}`;
  console.log(`\n>>> 抓取 [${mkt}] 最近 ${DAYS} 天: ${url}`);
  const data = await fetchJson(url);

  if (!data.images || data.images.length === 0) {
    console.warn(`  [${mkt}] 无数据`);
    return [];
  }

  const added = [];
  for (const img of data.images) {
    const id = extractId(img.urlbase);
    if (!id) continue;
    const key = `${mkt}|${id}`;
    if (existingKeys.has(key)) continue;

    const date = formatDate(img.startdate);
    const baseName = `${date}_${id}`;
    const entry = {
      date,
      id,
      mkt,
      title: img.title || '',
      copyright: img.copyright || '',
      files: {},
    };

    let ok = false;
    for (const { key: rKey, suffix } of RESOLUTIONS) {
      const imgUrl = `${BING}${img.urlbase}_${suffix}.jpg`;
      const fileName = `${baseName}_${suffix}.jpg`;
      const dest = path.join(WALLPAPER_DIR, fileName);
      try {
        const downloaded = await downloadFile(imgUrl, dest);
        entry.files[rKey] = `wallpapers/${fileName}`;
        ok = true;
        if (downloaded) console.log(`    ↓ ${fileName}`);
      } catch (err) {
        console.warn(`    × 跳过 ${suffix}: ${err.message}`);
      }
    }

    if (ok) {
      added.push(entry);
      existingKeys.add(key);
      console.log(`  + [${mkt}] ${date} ${img.title}`);
    }
  }
  return added;
}

async function main() {
  fs.mkdirSync(WALLPAPER_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

  const existing = loadExisting();
  const existingKeys = new Set(existing.map(e => `${e.mkt}|${e.id}`));
  console.log(`已有壁纸 ${existing.length} 条`);

  let allNew = [];
  for (const mkt of MARKETS) {
    try {
      const added = await processMarket(mkt, existingKeys);
      allNew = allNew.concat(added);
    } catch (err) {
      console.error(`  [${mkt}] 抓取失败: ${err.message}`);
    }
  }

  if (allNew.length === 0) {
    console.log('\n无新增壁纸，数据保持不变。');
    return;
  }

  let merged = [...allNew, ...existing];
  // 按日期倒序（新 -> 旧），同日期按地区排序
  merged.sort((a, b) => (b.date + b.mkt).localeCompare(a.date + a.mkt));

  // 可选：裁剪历史数据，控制仓库体积
  if (MAX_KEEP > 0 && merged.length > MAX_KEEP) {
    console.log(`\nMAX_KEEP=${MAX_KEEP}，裁剪 ${merged.length - MAX_KEEP} 条旧数据...`);
    const removed = merged.slice(MAX_KEEP);
    merged = merged.slice(0, MAX_KEEP);
    // 删除被裁剪条目对应的图片文件
    for (const e of removed) {
      for (const f of Object.values(e.files || {})) {
        const p = path.join(ROOT, f);
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          console.log(`    - 删除 ${f}`);
        }
      }
    }
  }

  fs.writeFileSync(DATA_FILE, JSON.stringify(merged, null, 2) + '\n');
  console.log(`\n✅ 新增 ${allNew.length} 条，当前共 ${merged.length} 条 -> data/wallpapers.json`);
}

main().catch(err => {
  console.error('❌ 执行失败:', err);
  process.exit(1);
});
