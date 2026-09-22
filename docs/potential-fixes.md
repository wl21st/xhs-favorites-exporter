# 小红书收藏导出器 (XHS Favorites Exporter) - 代码审查与修复建议方案

本文档汇总了针对本项目代码审查中发现的问题及对应的具体修复方案与参考代码实现。

---

## 目录
1. [P0 - 修复 SSR 首屏数据解析与索引硬编码](#1-p0---修复-ssr-首屏数据解析与索引硬编码)
2. [P1 - 增强网络层拦截：状态码校验与 Fetch API 代理](#2-p1---增强网络层拦截状态码校验与-fetch-api-代理)
3. [P1 - 收敛 DOM 扫描边界与增加页面路由校验](#3-p1---收敛-dom-扫描边界与增加页面路由校验)
4. [P2 - 优化 postMessage 通信安全与状态渲染](#4-p2---优化-postmessage-通信安全与状态渲染)
5. [P2 - 智能滚动容器识别与状态重置完善](#5-p2---智能滚动容器识别与状态重置完善)

---

## 1. P0 - 修复 SSR 首屏数据解析与索引硬编码

### 问题定位
文件：`page-bridge.js` 第 231-237 行
```javascript
// 原代码问题：无论判断真假均使用下标 [1]，且硬编码 [1] 假定收藏固定在第二个 Tab
var favoriteList = Array.isArray(notesCollection)
  ? notesCollection[1]
  : notesCollection[1];
var favoriteQuery = Array.isArray(queriesCollection)
  ? queriesCollection[1]
  : queriesCollection && queriesCollection[1];
```

### 修复方案
在小红书主页状态中，各 Tab 的顺序和结构可能变化。编写一个专用的提取辅助函数，支持按 Tab 特征或动态寻找包含有效收藏结构的数据项，并提供容错处理。

```javascript
// 建议替换实现
function findFavoriteCollection(collection) {
  var unwrapped = unwrapReactive(collection);
  if (!unwrapped) return null;

  if (Array.isArray(unwrapped)) {
    // 优先尝试寻找包含 items / noteList 且非空的项，或者安全回退至索引 1
    for (var i = 0; i < unwrapped.length; i++) {
      var candidate = unwrapReactive(unwrapped[i]);
      if (candidate && (candidate.items || candidate.noteList || candidate.list)) {
        return candidate;
      }
    }
    return unwrapped[1] || unwrapped[0] || null;
  }

  if (isPlainObject(unwrapped)) {
    return unwrapped.collect || unwrapped.favorite || unwrapped[1] || unwrapped;
  }

  return null;
}

function readInitialSnapshot() {
  var state = unwrapReactive(window.__INITIAL_STATE__);
  if (!state || !state.user) {
    return null;
  }

  var userState = unwrapReactive(state.user) || {};
  var notesCollection = unwrapReactive(userState.notes);
  var queriesCollection = unwrapReactive(userState.noteQueries);

  if (!notesCollection) {
    return null;
  }

  var favoriteList = findFavoriteCollection(notesCollection);
  var favoriteQuery = findFavoriteCollection(queriesCollection) || {};

  var normalizedItems = extractFavoriteItems(favoriteList)
    .map(function mapFavoriteItem(item) {
      return normalizeFavoriteItem(item, "ssr");
    })
    .filter(Boolean);

  return {
    items: normalizedItems,
    page: normalizePageInfo(favoriteQuery)
  };
}
```

---

## 2. P1 - 增强网络层拦截：状态码校验与 Fetch API 代理

### 问题定位
文件：`page-bridge.js` 第 300-368 行
1. `XMLHttpRequest` 仅在 `load` 事件触发时解析，未判断 HTTP 状态码（如 429 限流或 401 会误报成功）。
2. 未代理 `window.fetch`。若小红书升级请求底层为 `fetch`，分页拦截将失效。

### 修复方案
1. 增加 HTTP 状态码（`status >= 200 && status < 300`）检查。
2. 封装统一的响应处理函数，并对 `window.fetch` 进行代理。

```javascript
// 提取通用的数据包处理逻辑
function handleCollectResponse(responseText, status, url, startedAt) {
  if (status < 200 || status >= 300) {
    emit("COLLECT_PAGE_ERROR", {
      status: status,
      url: url,
      message: "HTTP 请求失败，状态码: " + status
    });
    return;
  }

  var payload = parseCollectPayload(responseText);
  if (!payload) return;

  // 校验业务 code（小红书正常返回 code === 0）
  if (payload.code != null && payload.code !== 0) {
    emit("COLLECT_PAGE_ERROR", {
      status: status,
      code: payload.code,
      message: payload.msg || "接口返回业务错误"
    });
    return;
  }

  var data = unwrapReactive(payload.data) || {};
  var notes = Array.isArray(data.notes)
    ? data.notes
    : Array.isArray(data.note_list)
      ? data.note_list
      : [];

  emit("COLLECT_PAGE", {
    status: status,
    url: url,
    duration_ms: Date.now() - startedAt,
    page: {
      cursor: toStringOrNull(pickFirst([data.cursor])),
      has_more: Boolean(
        pickFirst([
          data.has_more,
          data.hasMore,
          data.has_more === false ? false : null
        ])
      ),
      num: data.num == null ? null : Number(data.num)
    },
    items: notes
      .map(function mapApiItem(item) {
        return normalizeFavoriteItem(item, "xhr");
      })
      .filter(Boolean)
  });
}

// 增强的 XHR Hook
function installXmlHttpRequestHook() {
  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__xhsFavoritesExporterMeta = {
      method: method ? String(method) : "GET",
      url: url ? String(url) : ""
    };
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend() {
    var meta = this.__xhsFavoritesExporterMeta;
    var startedAt = Date.now();

    if (meta && meta.url && meta.url.indexOf(COLLECT_PATH) !== -1) {
      this.addEventListener(
        "load",
        function onCollectPageLoaded() {
          var responseUrl = this.responseURL || meta.url || "";
          if (responseUrl.indexOf(COLLECT_PATH) === -1) return;
          handleCollectResponse(this.responseText, this.status, responseUrl, startedAt);
        },
        { once: true }
      );
    }

    return originalSend.apply(this, arguments);
  };
}

// 新增的 Fetch Hook (双重保障)
function installFetchHook() {
  if (typeof window.fetch !== "function") return;
  var originalFetch = window.fetch;

  window.fetch = function patchedFetch(input, init) {
    var url = typeof input === "string" ? input : (input && input.url ? input.url : "");
    var startedAt = Date.now();

    var promise = originalFetch.apply(this, arguments);
    if (url && url.indexOf(COLLECT_PATH) !== -1) {
      promise.then(function(response) {
        response.clone().text().then(function(text) {
          handleCollectResponse(text, response.status, response.url || url, startedAt);
        }).catch(function() {});
      }).catch(function() {});
    }
    return promise;
  };
}
```

---

## 3. P1 - 收敛 DOM 扫描边界与增加页面路由校验

### 问题定位
文件：`content-script.js` 第 386-409 行
- `document.querySelectorAll('a[href*="/explore/"]')` 是全页面无差别扫描。
- 用户如果点开笔记详情弹窗，弹窗内的“相关笔记”也会匹配到，被误当做收藏收集。
- 扩展在非收藏页面（如推荐流 `/explore`、搜索页）也会被激活并扫描。

### 修复方案
1. 校验当前页面路径是否为个人主页（`/user/profile/`）。若不在个人页，面板提示用户跳转。
2. 限制 DOM 扫描容器，排除弹窗容器（如 `.note-detail-mask`、模态框）及推荐区域。

```javascript
// 1. 页面检测辅助函数
function isProfileCollectPage() {
  var path = window.location.pathname;
  return path.indexOf("/user/profile") !== -1;
}

// 2. 收敛 DOM 扫描区域
function scanDomCards() {
  if (!isProfileCollectPage()) {
    return { added: 0, updated: 0 };
  }

  // 排除详情弹层、侧边栏推荐等容器中的链接
  var excludedContainers = document.querySelectorAll(
    '.note-detail-mask, .feed-recommend-container, .related-notes'
  );

  var anchors = Array.from(document.querySelectorAll('a[href*="/explore/"]'));
  var payload = [];

  anchors.forEach(function collectAnchor(anchor) {
    // 检查是否在排除容器内
    for (var i = 0; i < excludedContainers.length; i++) {
      if (excludedContainers[i].contains(anchor)) {
        return;
      }
    }

    var parsed = parseNoteIdFromHref(anchor.getAttribute("href") || anchor.href);
    if (!parsed || !parsed.note_id) return;

    payload.push({
      note_id: parsed.note_id,
      xsec_token: parsed.xsec_token,
      url: parsed.url,
      title: extractTitleFromAnchor(anchor),
      source: "dom",
      captured_at: new Date().toISOString()
    });
  });

  state.lastDomScanAt = Date.now();
  return mergeItems(payload);
}
```

---

## 4. P2 - 优化 postMessage 通信安全与状态渲染

### 问题定位
1. `page-bridge.js` 第 21 行：`window.postMessage(..., "*")` 使用了通配符。
2. `content-script.js` 第 449 行：`ui.statusValue.innerHTML = escapeHtml(state.statusText)` 存在不必要且不完善的 HTML 拼接。

### 修复方案
1. `page-bridge.js` 中限定目标 origin 为 `window.location.origin`。
2. `content-script.js` 中使用 `textContent` 进行纯文本安全赋值。

```javascript
// page-bridge.js
function emit(type, payload) {
  window.postMessage(
    {
      source: BRIDGE_SOURCE,
      type: type,
      payload: payload || {}
    },
    window.location.origin
  );
}

// content-script.js
function render() {
  if (!ui.host) return;

  ui.countValue.textContent = String(state.items.size);
  ui.tokenValue.textContent = String(countMissingTokens());
  ui.sourceValue.textContent = summarizeSources();
  ui.statusValue.textContent = state.statusText; // 直接使用 textContent
  ui.startButton.disabled = state.running;
  ui.stopButton.disabled = !state.running;
  ui.exportButton.disabled = state.items.size === 0;
}
```

---

## 5. P2 - 智能滚动容器识别与状态重置完善

### 问题定位
1. `content-script.js` 第 461-482 行：滚动仅针对 `document.scrollingElement`。如果小红书 PC 端在某些特定视口下使用带 `overflow-y: auto` 的主视图容器，滚动指令将无效。
2. `resetResults()` 未重置 `idleRounds`。

### 修复方案
1. 增加滚动容器探测逻辑。
2. 在 `resetResults()` 中重置 `idleRounds`。

```javascript
// 获取实际可滚动的容器
function getScrollContainer() {
  var docScroller = document.scrollingElement || document.documentElement || document.body;
  if (docScroller && docScroller.scrollHeight > docScroller.clientHeight + 10) {
    return docScroller;
  }

  // 寻找常见的内容区域滚动容器
  var candidates = document.querySelectorAll(
    '.main-container, .feeds-container, #app, .user-page'
  );
  for (var i = 0; i < candidates.length; i++) {
    var el = candidates[i];
    if (el.scrollHeight > el.clientHeight + 10) {
      var overflow = window.getComputedStyle(el).overflowY;
      if (overflow === "auto" || overflow === "scroll") {
        return el;
      }
    }
  }

  return docScroller;
}

function isNearBottom() {
  var scroller = getScrollContainer();
  if (!scroller) return false;
  return scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 120;
}

function scrollOnce() {
  var scroller = getScrollContainer();
  if (!scroller) return;

  var step = Math.max(480, Math.floor((scroller.clientHeight || window.innerHeight) * 0.82));
  scroller.scrollBy({
    top: step,
    left: 0,
    behavior: "smooth"
  });
}

function resetResults() {
  stopCollection("已清空本次结果");
  state.items.clear();
  state.idleRounds = 0; // 彻底重置计数
  state.pageInfo = null;
  state.lastGrowthAt = 0;
  state.lastNetworkAt = 0;
  render();
}
```
