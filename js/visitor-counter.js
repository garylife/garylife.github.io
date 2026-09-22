/* 访客计数器 —— 前端接入脚本
 *
 * 数据来自自建的 Cloudflare Worker，源码在同仓库的 counter-worker/ 目录，
 * 部署步骤见 counter-worker/README.md。
 *
 * 部署完成后只需要改下面这一行 ENDPOINT，其它都不用动。
 *
 * 设计约定：脚本只在真正拿到数据之后，才把页脚那一行显示出来。
 * 所以 Worker 还没部署、或者被广告拦截插件挡住时，页脚看起来和原来完全一样，
 * 不会留下 "-" 或 0 这种半成品状态，也不会报错打扰访客。
 */
(function () {
    'use strict';

    var ENDPOINT = 'https://garylife-counter.PASTE-YOUR-SUBDOMAIN.workers.dev';

    // 占位符还没替换就先不执行，保证部署前页面行为完全不变
    if (!ENDPOINT || ENDPOINT.indexOf('PASTE-YOUR-SUBDOMAIN') !== -1) return;

    var box = document.getElementById('visitor-counter');
    if (!box) return;

    var pvEl = document.getElementById('vc-site-pv');
    var uvEl = document.getElementById('vc-site-uv');

    function makeId() {
        if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
        return 'v-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    }

    function format(n) {
        return typeof n === 'number' && isFinite(n) ? n.toLocaleString('en-US') : '-';
    }

    // localStorage 在隐私模式下可能不可用，取不到就退化成「不判定 UV」
    var uid = null;
    var isFirstVisit = false;
    try {
        uid = window.localStorage.getItem('vc_uid');
        if (!uid) {
            uid = makeId();
            window.localStorage.setItem('vc_uid', uid);
        }
        isFirstVisit = !window.localStorage.getItem('vc_counted');
    } catch (e) {
        uid = null;
    }

    var url = ENDPOINT.replace(/\/+$/, '') + '/hit?path=' + encodeURIComponent(window.location.pathname || '/');
    if (uid) url += '&uid=' + encodeURIComponent(uid);
    if (isFirstVisit) url += '&new=1';

    fetch(url, { mode: 'cors', cache: 'no-store' })
        .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
        })
        .then(function (data) {
            if (pvEl) pvEl.textContent = format(data.site_pv);
            if (uvEl) uvEl.textContent = format(data.site_uv);
            box.style.display = '';
            if (isFirstVisit) {
                try {
                    window.localStorage.setItem('vc_counted', '1');
                } catch (e) {
                    /* 忽略 */
                }
            }
        })
        .catch(function () {
            // 静默失败：不显示、不报错、不打扰访客
        });
})();
