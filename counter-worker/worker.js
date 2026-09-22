/**
 * garylife 访客计数器 —— Cloudflare Worker + KV
 *
 * 接口：
 *   GET /hit?path=/&uid=xxx&new=1   记一次访问，并返回最新计数
 *   GET /stats?path=/               只读，不计数
 *   GET /                           健康检查
 *
 * 返回：{ site_pv, site_uv, page_pv, path, counted }
 *
 * KV 键：
 *   site:pv           站点总访问量
 *   site:uv           累计访客数（前端 localStorage 判定“首次”，只有首次访问才 +1）
 *   page:pv:<path>    单页访问量
 *   dedup:<hash>      60 秒去重标记，自动过期
 */

// ---------- 可调参数 ----------

// 同一 IP + 同一页面，在 DEDUP_WINDOW 秒内只记一次，防止刷新/F5 灌水。
// 关掉它可以省下约 1/3 的 KV 写入额度，代价是每次刷新都会 +1。
const ENABLE_DEDUP = true;
const DEDUP_WINDOW = 60;

// 路径最长保留多少字符，过长的直接截断，防止有人拿超长 path 撑爆 KV 键名。
const MAX_PATH_LEN = 200;

const KEY_SITE_PV = 'site:pv';
const KEY_SITE_UV = 'site:uv';
const PAGE_PREFIX = 'page:pv:';

// ---------- 基础设施 ----------

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const JSON_HEADERS = Object.assign(
  {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  },
  CORS_HEADERS
);

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: JSON_HEADERS,
  });
}

// 把各种形式的 path 归一到 "/xxx"：去掉协议域名、query、hash、重复斜杠、末尾斜杠
function normalizePath(raw) {
  if (!raw) return '/';
  let p = String(raw).slice(0, MAX_PATH_LEN * 3);
  p = p.replace(/^https?:\/\/[^/]+/i, '');
  p = p.split('?')[0].split('#')[0];
  if (p.charAt(0) !== '/') p = '/' + p;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1 && p.slice(-1) === '/') p = p.slice(0, -1);
  return p.slice(0, MAX_PATH_LEN) || '/';
}

async function readInt(env, key) {
  const raw = await env.COUNTER.get(key);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// KV 没有原子自增，只能读-改-写。个人站流量下够用，并发极高时可能丢几次计数。
async function bump(env, key, by) {
  const next = (await readInt(env, key)) + (by || 1);
  await env.COUNTER.put(key, String(next));
  return next;
}

// 用 IP + UA + 路径 + 时间片做一次性哈希，不落库原始 IP
async function isDuplicate(request, path, env) {
  if (!ENABLE_DEDUP) return false;

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const bucket = Math.floor(Date.now() / (DEDUP_WINDOW * 1000));
  const raw = ip + '|' + ua + '|' + path + '|' + bucket;

  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  const hash = Array.from(new Uint8Array(digest))
    .map(function (b) {
      return b.toString(16).padStart(2, '0');
    })
    .join('')
    .slice(0, 32);

  const key = 'dedup:' + hash;
  const seen = await env.COUNTER.get(key);
  if (seen) return true;

  await env.COUNTER.put(key, '1', { expirationTtl: DEDUP_WINDOW * 2 });
  return false;
}

async function readCounts(env, path) {
  const values = await Promise.all([
    readInt(env, KEY_SITE_PV),
    readInt(env, KEY_SITE_UV),
    readInt(env, PAGE_PREFIX + path),
  ]);
  return { site_pv: values[0], site_uv: values[1], page_pv: values[2], path: path };
}

// ---------- 入口 ----------

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method_not_allowed' }, 405);
    }

    const url = new URL(request.url);
    const route = url.pathname.replace(/\/{2,}/g, '/').replace(/(.+)\/$/, '$1');

    if (route === '' || route === '/') {
      return json({
        ok: true,
        service: 'garylife-visitor-counter',
        endpoints: ['/hit?path=/&uid=&new=1', '/stats?path=/'],
      });
    }

    const path = normalizePath(url.searchParams.get('path') || url.searchParams.get('p') || '/');

    if (route === '/stats') {
      return json(await readCounts(env, path));
    }

    if (route !== '/hit') {
      return json({ error: 'not_found', hint: '可用接口：/hit 与 /stats' }, 404);
    }

    const duplicate = await isDuplicate(request, path, env);

    // 被去重挡掉：直接回读当前值，一个写操作都不做
    if (duplicate) {
      const counts = await readCounts(env, path);
      counts.counted = false;
      return json(counts);
    }

    const sitePv = await bump(env, KEY_SITE_PV);
    const pagePv = await bump(env, PAGE_PREFIX + path);

    // UV 由前端判定：只有浏览器第一次访问时才会带 new=1，省掉一次全量去重。
    // 同时受 60 秒去重约束，避免首访时开多个标签页把 UV 重复计上。
    const siteUv =
      url.searchParams.get('new') === '1' ? await bump(env, KEY_SITE_UV) : await readInt(env, KEY_SITE_UV);

    return json({
      site_pv: sitePv,
      site_uv: siteUv,
      page_pv: pagePv,
      path: path,
      counted: true,
    });
  },
};
