# garylife-counter

站点访问量计数器。跑在 Cloudflare Workers 上，数据存在 Workers KV 里，不依赖任何第三方统计服务。

- 免费额度足够个人站使用
- 数据完全在自己账号里，随时可导出、可删除，不存在服务方跑路的问题
- 不写 Cookie，不落库访客 IP（去重用的是一次性哈希，60 秒后自动过期）
- 前端脚本静默失败：Worker 挂掉或被拦截时，页脚不显示、不报错

## 接口

| 接口 | 说明 |
| --- | --- |
| `GET /hit?path=/&uid=<uuid>&new=1` | 记一次访问并返回最新计数，页面加载时调用 |
| `GET /stats?path=/` | 只读查询，不产生计数 |
| `GET /` | 健康检查，返回服务信息 |

返回体：

```json
{ "site_pv": 1234, "site_uv": 567, "page_pv": 1234, "path": "/", "counted": true }
```

- `site_pv` 站点总访问量
- `site_uv` 累计访客数（浏览器维度，前端 localStorage 判定「首次」）
- `page_pv` 当前路径的访问量
- `counted` 本次请求是否真的计入了（`false` 表示被 60 秒去重挡掉）

## 部署

先说明两件事：**Cloudflare 注册免费，只要有邮箱，不需要绑卡，也不需要买域名**；而本地跑起来（`wrangler dev`）只能自己看，要让访客看到必须部署到线上拿到一个公网地址。

### 路线 A：纯网页操作，零安装（推荐，一次性部署用这条）

不需要装 Node、不需要装 wrangler。

1. 打开 https://dash.cloudflare.com/sign-up 注册，邮箱验证即可。
2. 左侧 **Workers & Pages**，首次会让你设一个 **workers.dev 子域名**（如 `garylife`）。这个名字全局唯一，被占就换一个，它决定最后域名的后缀。
3. 左侧 **Storage & Databases → KV**（老账号在 Workers & Pages → KV）→ **Create instance**，名字填 `garylife-counter`。
4. **Workers & Pages → Create application → Create Worker**，名字填 `garylife-counter`（这个名字决定 URL 前缀），点 **Deploy**。
   - 注意："Create Worker" 在上一步点进 Create application 之后才出现；网上老教程写的 "Start with Hello World" 是已过时的旧标签。
5. 进这个 Worker 的详情页，点 **Edit code** 打开在线编辑器 → **全选删掉示例代码** → 粘贴本目录 `worker.js` 的**全部内容** → 点 **Deploy**。
6. **Settings → Bindings → Add → KV namespace**：
   - Variable name 填 `COUNTER`（必须一字不差，代码里就是读这个名字）
   - KV namespace 选第 3 步建的 `garylife-counter`
   - 保存后**需要再 Deploy 一次**才会生效
7. 页面上的访问地址形如 `https://garylife-counter.<你的子域>.workers.dev`。

菜单名 Cloudflare 改过好几轮，找不到就用顶部搜索框搜 `KV` 或 `Workers`。

### 路线 B：wrangler 命令行（以后要反复改代码再走这条）

需要 Node.js 18+，命令都在本目录下执行。

```bash
# 1. 登录 Cloudflare（会打开浏览器授权）
npx wrangler login

# 2. 创建 KV 命名空间，命令会打印一段 id
npx wrangler kv namespace create COUNTER

# 3. 把打印出来的 id 填进 wrangler.toml 的 [[kv_namespaces]] 里

# 4. 部署
npx wrangler deploy   # 输出形如 https://garylife-counter.<子域>.workers.dev
```

想先在本地看效果、暂时不部署，可以跑：

```bash
npx wrangler dev      # 本地起一个 http://localhost:8787，KV 用本地模拟
```

这个地址只有你自己这台机器能访问，填进 `js/visitor-counter.js` 的 `ENDPOINT` 就能在本机预览真实计数效果——但它永远不可能给访客看到，上线还是得走 A 或 B。

### 验证

已部署地址：`https://garylife-counter.garylife.workers.dev`

```bash
curl "https://garylife-counter.garylife.workers.dev/"              # 健康检查
curl "https://garylife-counter.garylife.workers.dev/stats?path=/"   # 只读，不计数
curl "https://garylife-counter.garylife.workers.dev/hit?path=/"     # 计数一次
```

连打两次 `/hit?path=/`，第二次的 `counted` 应该是 `false`、数字不涨，说明去重生效。

> 注意：`/` 是健康检查，**不读 KV**，所以它返回正常并不代表绑定成功。
> 要确认 KV 绑定生效，必须打 `/stats` 或 `/hit`——绑定没生效时这两个会返回 500。

## 接进站点

`js/visitor-counter.js` 顶部的 `ENDPOINT` 已指向上面那个地址：

```js
var ENDPOINT = 'https://garylife-counter.garylife.workers.dev';
```

页脚那行 `<li id="visitor-counter">` 默认是 `display: none`，拿到数据后才显示，所以这段代码可以先提交、后部署，顺序反过来也不会出问题。

## 免费额度

Workers / KV 的免费额度足够个人站，但要留意 KV 的写入次数：

| 项目 | 免费额度 | 说明 |
| --- | --- | --- |
| Worker 请求 | 10 万次/天 | 绰绰有余 |
| KV 读取 | 10 万次/天 | 每次访问约 4 次读 |
| KV 写入 | 1000 次/天 | **每次访问约 3 次写，瓶颈在这里** |

按现在的写法（去重开启），每天大约能顶 300+ 次访问。个人站基本够，真跑满了有三个选择：把 `worker.js` 里的 `ENABLE_DEDUP` 改成 `false`（省掉 1/3 写入，代价是刷新会重复计数）、升级 Workers 付费版（$5/月）、或者换 Durable Objects 做原子计数。

## 已知限制

- **计数会偏低**：写 `dedup:` 和读 `site:pv` 都依赖 KV 的最终一致性，热点流量下可能有几十秒的读数延迟；被广告拦截插件挡掉的访问也不会被记录。
- **不是原子自增**：KV 没有原子的 `INCR`，高并发下可能丢几次计数。个人站可以忽略。
- **UV 是浏览器维度**：换浏览器、清缓存、开隐私模式都会被算成新访客；同一台设备多次访问只算一次。
- **接口是公开的**：前端代码里能看到地址，理论上可以被脚本刷。真要防，去 Cloudflare 控制台给这个 Worker 加一条速率限制规则。

## 国内可达性

`*.workers.dev` 域名在国内访问不稳定，可能被墙。如果访客主要在国内，建议给 Worker 绑一个自有域名（Cloudflare 控制台 → 该 Worker → Settings → Domains & Routes → Add Custom Domain），比如 `cnt.你的域名.com`，然后把 `js/visitor-counter.js` 里的 `ENDPOINT` 改成这个域名。前提是这个域名托管在 Cloudflare。
