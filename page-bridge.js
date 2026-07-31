(function bootstrapFavoritesExporterBridge() {
  if (window.__XHS_FAVORITES_EXPORTER_BRIDGE__) {
    return;
  }

  window.__XHS_FAVORITES_EXPORTER_BRIDGE__ = true;

  var BRIDGE_SOURCE = "xhs-favorites-exporter";
  var COLLECT_PATH = "/api/sns/web/v2/note/collect/page";
  var HOMEFEED_PATH = "/api/sns/web/v1/homefeed";
  var initialSnapshotSent = false;
  var pollAttempts = 0;
  var maxPollAttempts = 60;

  function emit(type, payload) {
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        type: type,
        payload: payload || {}
      },
      "*"
    );
  }

  function isPlainObject(value) {
    return Object.prototype.toString.call(value) === "[object Object]";
  }

  function unwrapReactive(value, depth) {
    var nextDepth = depth || 0;

    if (nextDepth > 8 || value == null) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map(function mapArrayItem(item) {
        return unwrapReactive(item, nextDepth + 1);
      });
    }

    if (typeof value !== "object") {
      return value;
    }

    if (Object.prototype.hasOwnProperty.call(value, "_rawValue")) {
      return unwrapReactive(value._rawValue, nextDepth + 1);
    }

    if (Object.prototype.hasOwnProperty.call(value, "__v_raw")) {
      return unwrapReactive(value.__v_raw, nextDepth + 1);
    }

    if (
      Object.prototype.hasOwnProperty.call(value, "value") &&
      Object.keys(value).length <= 4
    ) {
      return unwrapReactive(value.value, nextDepth + 1);
    }

    return value;
  }

  function pickFirst(values) {
    for (var index = 0; index < values.length; index += 1) {
      var candidate = values[index];

      if (candidate == null) {
        continue;
      }

      if (typeof candidate === "string" && candidate.trim() === "") {
        continue;
      }

      return candidate;
    }

    return null;
  }

  function resolveCover(noteCard) {
    var cover = noteCard && noteCard.cover ? unwrapReactive(noteCard.cover) : null;
    var infoList = cover && (cover.info_list || cover.infoList);

    if (Array.isArray(infoList)) {
      for (var index = 0; index < infoList.length; index += 1) {
        var item = unwrapReactive(infoList[index]);
        var itemUrl = pickFirst([item && item.url, item && item.urlDefault]);

        if (itemUrl) {
          return itemUrl;
        }
      }
    }

    return pickFirst([
      cover && cover.url,
      cover && cover.url_default,
      cover && cover.urlDefault,
      cover && cover.default,
      cover && cover.src
    ]);
  }

  function toStringOrNull(value) {
    return value == null ? null : String(value);
  }

  function normalizeNoteItem(rawItem, source) {
    var item = unwrapReactive(rawItem) || {};
    var noteCard = unwrapReactive(item.noteCard) || unwrapReactive(item.note_card) || item;
    var user = unwrapReactive(noteCard.user) || unwrapReactive(item.user) || {};
    var interactInfo =
      unwrapReactive(noteCard.interactInfo) ||
      unwrapReactive(noteCard.interact_info) ||
      unwrapReactive(item.interactInfo) ||
      unwrapReactive(item.interact_info) ||
      {};

    var noteId = pickFirst([
      item.id,
      item.noteId,
      item.note_id,
      noteCard.noteId,
      noteCard.note_id
    ]);

    if (!noteId) {
      return null;
    }

    var xsecToken = pickFirst([
      item.xsecToken,
      item.xsec_token,
      noteCard.xsecToken,
      noteCard.xsec_token
    ]);

    var title = pickFirst([
      noteCard.displayTitle,
      noteCard.display_title,
      item.displayTitle,
      item.display_title,
      item.title
    ]);

    var author = pickFirst([
      user.nickName,
      user.nick_name,
      user.nickname,
      user.name
    ]);

    var likedCount = pickFirst([
      interactInfo.likedCount,
      interactInfo.liked_count
    ]);

    var baseUrl = "https://www.xiaohongshu.com/explore/" + encodeURIComponent(String(noteId));
    var url = xsecToken
      ? baseUrl + "?xsec_token=" + encodeURIComponent(String(xsecToken))
      : baseUrl;

    return {
      note_id: String(noteId),
      xsec_token: toStringOrNull(xsecToken),
      url: url,
      title: toStringOrNull(title),
      author: toStringOrNull(author),
      cover: toStringOrNull(resolveCover(noteCard)),
      liked_count: toStringOrNull(likedCount),
      note_type: toStringOrNull(pickFirst([noteCard.type, item.type])),
      source: source,
      captured_at: new Date().toISOString()
    };
  }

  function normalizePageInfo(rawQuery) {
    var query = unwrapReactive(rawQuery) || {};

    return {
      cursor: toStringOrNull(pickFirst([query.cursor, query.cursor_score, query.cursorScore])),
      has_more: Boolean(
        pickFirst([query.hasMore, query.has_more, query.hasMore === false ? false : null])
      ),
      num: query.num == null ? null : Number(query.num),
      page: query.page == null ? null : Number(query.page)
    };
  }

  function extractFavoriteItems(rawCollection) {
    var collection = unwrapReactive(rawCollection);

    if (Array.isArray(collection)) {
      return collection;
    }

    if (!collection || !isPlainObject(collection)) {
      return [];
    }

    if (Array.isArray(collection.items)) {
      return collection.items;
    }

    if (Array.isArray(collection.noteList)) {
      return collection.noteList;
    }

    if (Array.isArray(collection.list)) {
      return collection.list;
    }

    return [];
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

    var favoriteList = Array.isArray(notesCollection)
      ? notesCollection[1]
      : notesCollection[1];
    var favoriteQuery = Array.isArray(queriesCollection)
      ? queriesCollection[1]
      : queriesCollection && queriesCollection[1];

    var normalizedItems = extractFavoriteItems(favoriteList)
      .map(function mapFavoriteItem(item) {
        return normalizeNoteItem(item, "ssr");
      })
      .filter(Boolean);

    return {
      items: normalizedItems,
      page: normalizePageInfo(favoriteQuery)
    };
  }

  function readHomefeedSnapshot() {
    var state = unwrapReactive(window.__INITIAL_STATE__);

    if (!state) {
      return null;
    }

    var feedState = unwrapReactive(state.feed);

    if (!feedState) {
      return null;
    }

    var feeds = unwrapReactive(feedState.feeds);

    if (!feeds) {
      return null;
    }

    var items = Array.isArray(feeds) ? feeds : [];

    if (!items.length) {
      return null;
    }

    var normalizedItems = items
      .map(function mapFeedItem(item) {
        return normalizeNoteItem(item, "ssr");
      })
      .filter(Boolean);

    return {
      items: normalizedItems,
      page: { cursor: null, has_more: true, num: null, page: null }
    };
  }

  function tryEmitInitialSnapshot(force) {
    var snapshot = readInitialSnapshot();

    if (!snapshot) {
      return false;
    }

    if (!force && initialSnapshotSent && snapshot.items.length === 0) {
      return false;
    }

    if (
      !force &&
      initialSnapshotSent &&
      snapshot.items.length === 0 &&
      !snapshot.page.cursor
    ) {
      return false;
    }

    if (snapshot.items.length > 0 || snapshot.page.cursor || snapshot.page.has_more) {
      emit("INITIAL_SNAPSHOT", snapshot);
      initialSnapshotSent = true;
      return true;
    }

    return false;
  }

  function tryEmitHomefeedSnapshot(force) {
    var snapshot = readHomefeedSnapshot();

    if (!snapshot) {
      return false;
    }

    if (!force && initialSnapshotSent) {
      return false;
    }

    if (snapshot.items.length > 0) {
      emit("INITIAL_SNAPSHOT", snapshot);
      initialSnapshotSent = true;
      return true;
    }

    return false;
  }

  function startInitialStatePolling(isHomefeed) {
    var timer = window.setInterval(function pollInitialState() {
      pollAttempts += 1;

      var emitted = isHomefeed
        ? tryEmitHomefeedSnapshot(false)
        : tryEmitInitialSnapshot(false);

      if (emitted || pollAttempts >= maxPollAttempts) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  function parseCollectPayload(responseText) {
    try {
      return JSON.parse(responseText);
    } catch (error) {
      emit("XHR_PARSE_ERROR", {
        message: String(error)
      });
      return null;
    }
  }

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

      if (meta && meta.url) {
        var isCollect = meta.url.indexOf(COLLECT_PATH) !== -1;
        var isHomefeed = meta.url.indexOf(HOMEFEED_PATH) !== -1;

        if (isCollect || isHomefeed) {
          this.addEventListener(
            "load",
            function onXhrLoaded() {
              var responseUrl = this.responseURL || meta.url || "";
              var matchCollect = responseUrl.indexOf(COLLECT_PATH) !== -1;
              var matchHomefeed = responseUrl.indexOf(HOMEFEED_PATH) !== -1;

              if (!matchCollect && !matchHomefeed) {
                return;
              }

              var payload = parseCollectPayload(this.responseText);

              if (!payload) {
                return;
              }

              var data = unwrapReactive(payload.data) || {};

              if (matchCollect) {
                var notes = Array.isArray(data.notes)
                  ? data.notes
                  : Array.isArray(data.note_list)
                    ? data.note_list
                    : [];

                emit("COLLECT_PAGE", {
                  status: this.status,
                  url: responseUrl,
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
                      return normalizeNoteItem(item, "xhr");
                    })
                    .filter(Boolean)
                });
              }

              if (matchHomefeed) {
                var feedItems = Array.isArray(data.items) ? data.items : [];
                var feedSource = currentMode === "following" ? "feed-following" : "feed-home";

                emit("FEED_PAGE", {
                  status: this.status,
                  url: responseUrl,
                  duration_ms: Date.now() - startedAt,
                  page: {
                    cursor: toStringOrNull(pickFirst([data.cursor_score, data.cursorScore, data.cursor])),
                    has_more: data.items && data.items.length > 0
                  },
                  items: feedItems
                    .filter(function keepNotes(item) {
                      return !item.model_type || item.model_type === "note";
                    })
                    .map(function mapFeedItem(item) {
                      return normalizeNoteItem(item, feedSource);
                    })
                    .filter(Boolean)
                });
              }
            },
            { once: true }
          );
        }
      }

      return originalSend.apply(this, arguments);
    };
  }

  function detectMode() {
    var path = window.location.pathname;

    if (path === "/" || path === "") {
      return "homepage";
    }

    if (path.indexOf("/following") !== -1) {
      return "following";
    }

    if (
      path.indexOf("/user/profile") !== -1 ||
      path.indexOf("/collection") !== -1
    ) {
      return "favorites";
    }

    return "homepage";
  }

  var currentMode = detectMode();

  window.addEventListener("xhs-favorites-exporter:scan-now", function forceScan() {
    if (currentMode === "homepage" || currentMode === "following") {
      tryEmitHomefeedSnapshot(true);
    } else {
      tryEmitInitialSnapshot(true);
    }
  });

  installXmlHttpRequestHook();

  var isHomefeedMode = currentMode === "homepage" || currentMode === "following";
  startInitialStatePolling(isHomefeedMode);

  emit("BRIDGE_READY", {
    collect_path: COLLECT_PATH,
    mode: currentMode
  });
})();
