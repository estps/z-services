/* Z Slides - front-end */
(function () {
  "use strict";

  var state = { me: null, decks: [], current: null, currentTheme: null, canva: null, canvaPoll: 0 };

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function api(path, options) {
    return fetch(path, Object.assign({ headers: { "Content-Type": "application/json" } }, options || {})).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw Object.assign(new Error(data.message || data.error || "Request failed"), { data: data, status: res.status });
        return data;
      });
    });
  }

  function initials(name) {
    var parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    var first = ((parts[0] || "?")[0] || "?").toUpperCase();
    var second = parts[1] ? (parts[1][0] || "").toUpperCase() : "";
    return first + second;
  }

  function renderAccount() {
    var box = $("account");
    box.innerHTML = "";
    var me = state.me;
    var avatar = el("span", "avatar", initials(me.name));
    var wrap = el("div", "account-info");
    wrap.appendChild(el("span", "account-name", me.name || "Signed in"));
    wrap.appendChild(el("span", "account-mail", me.email || ""));
    box.appendChild(avatar);
    box.appendChild(wrap);
  }

  function renderQuota(usage) {
    var q = $("quota");
    q.innerHTML = "";
    if (state.me && state.me.unlimited) {
      q.appendChild(el("span", "quota-num", "\u221E"));
      q.appendChild(el("span", "quota-label", "unlimited decks"));
      return;
    }
    q.appendChild(el("span", "quota-num", String(usage.left)));
    q.appendChild(el("span", "quota-label", usage.left === 1 ? "deck left this month" : "decks left this month"));
  }

  /* ---------------------------------------------------------------- rendering */

  function themeOf(raw) {
    return window.ZDeck ? window.ZDeck.normalizeTheme(raw || {}) : null;
  }

  function renderSlidesInto(container, slides, theme, deckTitle, onOpen, opts) {
    container.innerHTML = "";
    if (!window.ZDeck) return;
    opts = opts || {};
    slides.forEach(function (slide, i) {
      container.appendChild(window.ZDeck.slideCard(slide, i, {
        theme: theme,
        total: slides.length,
        deckTitle: deckTitle || "",
        editable: opts.editable,
        onEdit: opts.onEdit,
        onClick: onOpen ? function () { onOpen(i); } : null
      }));
    });
  }

  function renderDeckList() {
    var list = $("decklist");
    list.innerHTML = "";
    state.decks.forEach(function (deck) {
      var item = el("button", "deck-item" + (state.current && state.current.id === deck.id ? " is-active" : ""));
      item.appendChild(el("span", "deck-title", deck.title));
      item.appendChild(el("span", "deck-sub", deck.pages + " pages · " + new Date(deck.createdAt).toLocaleDateString()));
      item.addEventListener("click", function () { openDeck(deck.id); });
      list.appendChild(item);
    });
  }

  function renderCanvaStatus() {
    var box = $("canvaStatus");
    box.innerHTML = "";
    if (!state.canva || !state.canva.configured) return;
    if (state.canva.connected) {
      box.appendChild(el("span", "canva-chip", "Canva connected"));
    } else {
      var link = el("a", "canva-connect", "Connect Canva");
      link.href = "/auth/canva";
      box.appendChild(link);
      box.appendChild(el("span", "canva-hint", "to get decks in your Canva"));
    }
  }

  function renderCanvaBar(deck) {
    var btn = $("openCanvaBtn");
    var note = $("canvaNote");
    btn.hidden = true;
    note.hidden = true;
    note.innerHTML = "";
    if (!deck.canva) {
      if (state.canva && state.canva.configured && state.canva.connected) {
        var send = el("a", "btn btn-canva", "Send to Canva");
        send.href = "#";
        send.addEventListener("click", function (event) {
          event.preventDefault();
          sendDeckToCanva(deck.id, send);
        });
        note.appendChild(send);
        note.appendChild(el("span", "canva-hint", "  creates this deck in your Canva account"));
        note.hidden = false;
      } else if (state.canva && state.canva.configured) {
        note.textContent = "Connect Canva (bottom of the sidebar) to open this deck in your Canva account.";
        note.hidden = false;
      }
      return;
    }
    if (deck.canva.status === "success" && deck.canva.editUrl) {
      btn.href = deck.canva.editUrl;
      btn.hidden = false;
      note.textContent = "This deck is in your Canva account — edit it there, it's fully editable.";
      note.hidden = false;
    } else if (deck.canva.status === "in_progress") {
      note.textContent = "Sending to Canva…";
      note.hidden = false;
      pollCanva(deck.id);
    } else if (deck.canva.status === "failed") {
      note.textContent = "Canva import failed (" + (deck.canva.error || "unknown") + "). The deck is still safe here.";
      note.hidden = false;
    }
  }

  function sendDeckToCanva(deckId, btn) {
    btn.textContent = "Sending…";
    api("/api/decks/" + deckId + "/canva", { method: "POST" }).then(function (data) {
      if (!state.current || state.current.id !== deckId) return;
      state.current.canva = data;
      renderCanvaBar(state.current);
    }).catch(function (err) {
      btn.textContent = "Send to Canva";
      window.alert((err.data && err.data.message) || "Could not send to Canva. Try again.");
    });
  }

  function pollCanva(deckId) {
    var tries = state.canvaPoll = (state.canvaPoll || 0) + 1;
    if (tries > 20) return;
    window.setTimeout(function () {
      api("/api/decks/" + deckId + "/canva").then(function (data) {
        if (!state.current || state.current.id !== deckId) return;
        state.current.canva = data;
        renderCanvaBar(state.current);
        if (data.status === "in_progress") pollCanva(deckId);
      }).catch(function () {});
    }, 3000);
  }

  var editSaveTimer = null;
  function onSlideEdit(index, html) {
    if (!state.current || !state.current.slides || !state.current.slides[index]) return;
    state.current.slides[index].html = html;
    if (editSaveTimer) clearTimeout(editSaveTimer);
    editSaveTimer = setTimeout(persistDeckEdits, 800);
  }
  function persistDeckEdits() {
    if (!state.current || !state.current.id) return;
    var slides = (state.current.slides || []).map(function (sl) {
      return { html: sl.html || null, notes: sl.notes || null };
    });
    api("/api/decks/" + state.current.id, { method: "PUT", body: JSON.stringify({ slides: slides }) })
      .then(function () {
        var meta = $("deckMeta");
        if (meta) {
          var base = meta.getAttribute("data-base") || meta.textContent;
          meta.setAttribute("data-base", base);
          meta.textContent = base + " \u00b7 saved";
        }
      })
      .catch(function () {});
  }

  function openDeck(id) {
    api("/api/decks/" + id).then(function (data) {
      state.current = data.deck;
      state.currentTheme = themeOf(data.deck.theme);
      $("empty").hidden = true;
      $("viewer").hidden = false;
      $("deckTitle").textContent = data.deck.title;
      var invites = (data.deck.invitees || []).length ? "Invited: " + data.deck.invitees.join(", ") + " · " : "";
      $("deckMeta").textContent = invites + data.deck.slides.length + " slides · created " + new Date(data.deck.createdAt).toLocaleString();
      $("deckMeta").setAttribute("data-base", $("deckMeta").textContent);
      renderSlidesInto($("slides"), data.deck.slides || [], state.currentTheme, data.deck.title, openPresent, {
        editable: true,
        onEdit: onSlideEdit
      });
      renderCanvaBar(data.deck);
      renderDeckList();
      updatePresentFrames();
    }).catch(function () { /* deck may have been removed */ });
  }

  function deckAsText(deck) {
    var lines = [deck.title, ""];
    (deck.slides || []).forEach(function (slide, i) {
      lines.push("Slide " + (i + 1) + ": " + (slide.title || ""));
      if (slide.subtitle) lines.push("  " + slide.subtitle);
      if (slide.quote) lines.push("  \u201C" + (slide.quote.text || slide.quote) + "\u201D" + (slide.quote.attribution ? " \u2014 " + slide.quote.attribution : ""));
      (slide.bullets || []).forEach(function (b) { lines.push("  - " + b); });
      (slide.stats || []).forEach(function (s) { lines.push("  * " + (s.value || "") + " " + (s.label || "")); });
      (slide.timeline || []).forEach(function (t) { lines.push("  ~ " + (t.when || "") + ": " + (t.what || "")); });
      if (slide.compare) {
        if (slide.compare.left) lines.push("  [A] " + (slide.compare.left.title || "") + ": " + (slide.compare.left.points || []).join("; "));
        if (slide.compare.right) lines.push("  [B] " + (slide.compare.right.title || "") + ": " + (slide.compare.right.points || []).join("; "));
      }
      if (slide.image && slide.image.url) lines.push("  (image: " + (slide.image.credit || slide.image.query || slide.image.url) + ")");
      lines.push("");
    });
    return lines.join("\n");
  }

  $("copyBtn").addEventListener("click", function () {
    if (!state.current) return;
    navigator.clipboard.writeText(deckAsText(state.current)).then(function () {
      $("copyBtn").textContent = "Copied!";
      setTimeout(function () { $("copyBtn").textContent = "Copy as text"; }, 1500);
    });
  });

  /* -------------------------------------------------------------- create flow */

  var dialog = $("createDialog");
  var form = $("createForm");
  var buildState = { slidesData: [], theme: null, deckTitle: "" };

  function openDialog() {
    $("formError").hidden = true;
    var cutConfigured = state.canva && state.canva.configured;
    var canvaOk = cutConfigured && state.canva.connected;
    if (!canvaOk) {
      $("createFields").hidden = true;
      $("buildView").hidden = true;
      $("canvaGate").hidden = false;
      $("canvaGateText").textContent = cutConfigured
        ? "Presentations are created directly in your Canva account. Connect it once, then you can make decks anytime."
        : "Canva is not configured on this server yet, so presentations can't be created right now.";
      $("canvaGateBtn").hidden = !cutConfigured;
      dialog.showModal();
      return;
    }
    $("canvaGate").hidden = true;
    var maxPages = (state.me && state.me.maxPages) || 6;
    pages.max = String(maxPages);
    $("pagesHint").textContent = "(max " + maxPages + ")";
    if (Number(pages.value) > maxPages) pages.value = String(maxPages);
    $("pagesOut").textContent = pages.value + (pages.value === "1" ? " page" : " pages");
    if (state.me && !state.me.unlimited && state.me.usageLeft <= 0) {
      var plan = state.me.plan || "free";
      $("formError").textContent =
        plan === "free"
          ? "AI presentations are a Pro feature - get Pro (10 a month) or Max (unlimited) in Z Chat."
          : "You have used all " +
            ((state.me.usage && state.me.usage.limit) || 0) +
            " presentations this month. Upgrade to Max for unlimited.";
      $("formError").hidden = false;
    }
    dialog.showModal();
  }
  $("newBtn").addEventListener("click", openDialog);
  $("emptyNewBtn").addEventListener("click", openDialog);
  $("cancelBtn").addEventListener("click", function () { dialog.close(); });
  $("canvaGateClose").addEventListener("click", function () { dialog.close(); });

  function startBuildView() {
    buildState.slidesData = [];
    buildState.theme = null;
    buildState.deckTitle = "";
    $("canvaGate").hidden = true;
    $("createFields").hidden = true;
    $("buildView").hidden = false;
    $("buildTitle").textContent = "";
    $("buildStatus").textContent = "Starting\u2026";
    $("buildSlides").innerHTML = "";
    $("buildClose").hidden = true;
  }

  function renderBuildSlides() {
    renderSlidesInto($("buildSlides"), buildState.slidesData, buildState.theme, buildState.deckTitle, null);
    var box = $("buildSlides");
    box.scrollTop = box.scrollHeight;
  }

  function resetCreateView() {
    $("createFields").hidden = false;
    $("buildView").hidden = true;
    $("canvaGate").hidden = true;
  }

  function buildError(message) {
    $("buildStatus").textContent = message || "Something went wrong. Try again.";
    $("buildClose").hidden = false;
  }

  function handleBuildEvent(evt) {
    if (evt.type === "meta") {
      var hadTheme = Boolean(buildState.theme);
      if (evt.title) {
        buildState.deckTitle = evt.title;
        $("buildTitle").textContent = evt.title;
      }
      if (evt.theme) buildState.theme = themeOf(evt.theme);
      if (buildState.theme && !hadTheme && buildState.slidesData.length) renderBuildSlides();
    } else if (evt.type === "slide") {
      buildState.slidesData.push(evt.slide);
      var index = typeof evt.index === "number" ? evt.index : buildState.slidesData.length - 1;
      var frame = window.ZDeck ? window.ZDeck.slideCard(evt.slide, index, {
        theme: buildState.theme,
        total: 0,
        deckTitle: buildState.deckTitle
      }) : null;
      if (frame) {
        $("buildSlides").appendChild(frame);
        var box = $("buildSlides");
        box.scrollTop = box.scrollHeight;
      }
    } else if (evt.type === "status") {
      $("buildStatus").textContent = evt.text || "";
    } else if (evt.type === "done") {
      $("buildStatus").textContent = "Done \u2014 opening\u2026";
      window.setTimeout(function () {
        dialog.close();
        resetCreateView();
        refresh().then(function () { openDeck(evt.deck.id); });
      }, 700);
    } else if (evt.type === "error") {
      buildError(evt.message);
    }
  }

  $("buildClose").addEventListener("click", function () {
    dialog.close();
    resetCreateView();
  });

  var pages = $("pages");
  pages.addEventListener("input", function () { $("pagesOut").textContent = pages.value + (pages.value === "1" ? " page" : " pages"); });

  var DETAIL_LABELS = ["", "Lean", "Light", "Balanced", "Detailed", "In-depth"];
  var detail = $("detail");
  function renderDetail() { $("detailOut").textContent = DETAIL_LABELS[Number(detail.value)] || "Balanced"; }
  detail.addEventListener("input", renderDetail);
  renderDetail();

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var invitees = $("invitees").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var payload = { invitees: invitees, details: $("details").value, pages: Number(pages.value), detail: Number(detail.value) };
    startBuildView();
    fetch("/api/generate-stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(function (res) {
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          buildError(data.message || data.error || "Request failed");
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return reader.read().then(function (result) {
          if (result.done) return null;
          buffer += decoder.decode(result.value, { stream: true });
          var idx;
          while ((idx = buffer.indexOf("\n")) >= 0) {
            var line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            if (!line.trim()) continue;
            try {
              handleBuildEvent(JSON.parse(line));
            } catch (e) {
              /* skip malformed chunk */
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      buildError(err.message || "Generation failed. Try again.");
    });
  });

  /* --------------------------------------------------------- presentation mode */

  var presentState = { open: false, index: 0, frames: [], touchX: null };

  function presentScale() {
    var pad = 40;
    var w = Math.max(320, window.innerWidth - pad * 2);
    var h = Math.max(200, window.innerHeight - pad * 2 - 24);
    return Math.min(w / 1280, h / 720);
  }

  function updatePresentFrames() {
    if (!presentState.frames.length) return;
    var s = presentScale();
    var w = Math.max(1, Math.floor(1280 * s));
    var h = Math.max(1, Math.floor(720 * s));
    presentState.frames.forEach(function (frame) {
      frame.style.width = w + "px";
      frame.style.height = h + "px";
      frame.style.setProperty("--scale", String(s));
    });
  }

  function setPresentIndex(i) {
    var total = presentState.frames.length;
    if (!total) return;
    presentState.index = Math.max(0, Math.min(total - 1, i));
    presentState.frames.forEach(function (frame, idx) {
      frame.classList.toggle("is-active", idx === presentState.index);
    });
    $("presentCount").textContent = (presentState.index + 1) + " / " + total;
    $("presentBar").style.width = (((presentState.index + 1) / total) * 100) + "%";
    $("presentPrev").disabled = presentState.index === 0;
    $("presentNext").disabled = presentState.index === total - 1;
    var dots = $("presentDots").children;
    for (var d = 0; d < dots.length; d++) dots[d].classList.toggle("is-active", d === presentState.index);
  }

  function openPresent(index) {
    if (!state.current || !state.current.slides || !state.current.slides.length || !window.ZDeck) return;
    var overlay = $("present");
    var stage = $("presentStage");
    stage.innerHTML = "";
    presentState.frames = [];
    var theme = state.currentTheme || themeOf(state.current.theme);
    var slides = state.current.slides;
    slides.forEach(function (slide, i) {
      var frame = window.ZDeck.slideCard(slide, i, { theme: theme, total: slides.length, deckTitle: state.current.title });
      stage.appendChild(frame);
      presentState.frames.push(frame);
    });
    $("presentDeck").textContent = state.current.title || "";
    var dots = $("presentDots");
    dots.innerHTML = "";
    if (slides.length <= 14) {
      slides.forEach(function (_, i) {
        var dot = document.createElement("button");
        dot.type = "button";
        dot.className = "present-dot";
        dot.setAttribute("aria-label", "Slide " + (i + 1));
        dot.addEventListener("click", function () { setPresentIndex(i); });
        dots.appendChild(dot);
      });
    }
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
    presentState.open = true;
    updatePresentFrames();
    setPresentIndex(typeof index === "number" ? index : 0);
    if (overlay.requestFullscreen) overlay.requestFullscreen().catch(function () {});
  }

  function closePresent() {
    var overlay = $("present");
    overlay.hidden = true;
    presentState.open = false;
    document.body.style.overflow = "";
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
  }

  $("presentBtn").addEventListener("click", function () { openPresent(0); });
  $("presentClose").addEventListener("click", closePresent);
  $("presentPrev").addEventListener("click", function () { setPresentIndex(presentState.index - 1); });
  $("presentNext").addEventListener("click", function () { setPresentIndex(presentState.index + 1); });
  $("printBtn").addEventListener("click", function () {
    if (!state.current) return;
    window.print();
  });

  $("presentStage").addEventListener("click", function (event) {
    if (!presentState.open) return;
    var rect = this.getBoundingClientRect();
    var mid = rect.left + rect.width / 2;
    if (event.clientX >= mid) setPresentIndex(presentState.index + 1);
    else setPresentIndex(presentState.index - 1);
  });

  document.addEventListener("keydown", function (event) {
    if (!presentState.open) return;
    var key = event.key;
    if (key === "Escape") { event.preventDefault(); closePresent(); }
    else if (key === "ArrowRight" || key === "PageDown" || key === " " || key === "Enter") { event.preventDefault(); setPresentIndex(presentState.index + 1); }
    else if (key === "ArrowLeft" || key === "PageUp") { event.preventDefault(); setPresentIndex(presentState.index - 1); }
    else if (key === "Home") { event.preventDefault(); setPresentIndex(0); }
    else if (key === "End") { event.preventDefault(); setPresentIndex(presentState.frames.length - 1); }
  });

  $("present").addEventListener("touchstart", function (event) {
    presentState.touchX = event.changedTouches[0] ? event.changedTouches[0].clientX : null;
  }, { passive: true });
  $("present").addEventListener("touchend", function (event) {
    if (presentState.touchX === null || !event.changedTouches[0]) return;
    var dx = event.changedTouches[0].clientX - presentState.touchX;
    if (Math.abs(dx) > 48) setPresentIndex(presentState.index + (dx < 0 ? 1 : -1));
    presentState.touchX = null;
  }, { passive: true });

  window.addEventListener("resize", function () {
    if (presentState.open) updatePresentFrames();
  });

  document.addEventListener("fullscreenchange", function () {
    if (!document.fullscreenElement && presentState.open) closePresent();
  });

  /* ----------------------------------------------------------------- refresh */

  function refresh() {
    return Promise.all([api("/api/me"), api("/api/decks"), api("/api/canva/status")]).then(function (results) {
      state.me = results[0].user;
      state.me.usageLeft = results[0].usage.left;
      state.me.unlimited = Boolean(results[0].unlimited);
      state.me.maxPages = results[0].maxPages || 6;
      state.decks = results[1].decks;
      state.canva = results[2];
      renderAccount();
      renderQuota(results[0].usage);
      renderDeckList();
      renderCanvaStatus();
    });
  }

  refresh().then(function () {
    if (state.decks.length) openDeck(state.decks[0].id);
  }).catch(function () {
    window.location.href = "/auth/login";
  });
})();
