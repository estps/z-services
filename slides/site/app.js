/* Z Slides - front-end */
(function () {
  "use strict";

  var state = { me: null, decks: [], current: null, canva: null, canvaPoll: 0 };

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
    var parts = String(name || "?").trim().split(/\s+/);
    return ((parts[0] || "?")[0] + (parts[1] || "")[0] || "?").toUpperCase();
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
    q.appendChild(el("span", "quota-label", usage.left === 1 ? "free deck left" : "free decks left"));
  }

  function applyTheme(container, theme) {
    if (!container) return;
    if (theme && theme.bg) {
      container.style.setProperty("--slide-bg", "#" + theme.bg);
      container.style.setProperty("--slide-accent", "#" + theme.accent);
      container.style.setProperty("--slide-text", "#" + theme.text);
      container.style.setProperty("--slide-muted", "#" + theme.muted);
    } else {
      ["--slide-bg", "--slide-accent", "--slide-text", "--slide-muted"].forEach(function (name) {
        container.style.removeProperty(name);
      });
    }
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

  function slideCard(slide, index) {
    var card = el("article", "slide");
    card.appendChild(el("span", "slide-num", String(index + 1)));
    card.appendChild(el("h3", "slide-title", slide.title || ""));
    var ul = el("ul", "slide-bullets");
    (slide.bullets || []).forEach(function (b) { ul.appendChild(el("li", null, b)); });
    card.appendChild(ul);
    return card;
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

  function openDeck(id) {
    api("/api/decks/" + id).then(function (data) {
      state.current = data.deck;
      $("empty").hidden = true;
      $("viewer").hidden = false;
      $("deckTitle").textContent = data.deck.title;
      var invites = (data.deck.invitees || []).length ? "Invited: " + data.deck.invitees.join(", ") + " · " : "";
      $("deckMeta").textContent = invites + data.deck.slides.length + " slides · created " + new Date(data.deck.createdAt).toLocaleString();
      var slides = $("slides");
      slides.innerHTML = "";
      data.deck.slides.forEach(function (slide, i) { slides.appendChild(slideCard(slide, i)); });
      applyTheme(slides, data.deck.theme);
      renderCanvaBar(data.deck);
      renderDeckList();
    }).catch(function () { /* deck may have been removed */ });
  }

  function deckAsText(deck) {
    var lines = [deck.title, ""];
    deck.slides.forEach(function (slide, i) {
      lines.push("Slide " + (i + 1) + ": " + slide.title);
      (slide.bullets || []).forEach(function (b) { lines.push("  - " + b); });
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

  var dialog = $("createDialog");
  var form = $("createForm");
  var buildState = { slides: 0 };

  function openDialog() {
    $("formError").hidden = true;
    var maxPages = (state.me && state.me.maxPages) || 6;
    pages.max = String(maxPages);
    $("pagesHint").textContent = "(max " + maxPages + ")";
    if (Number(pages.value) > maxPages) pages.value = String(maxPages);
    $("pagesOut").textContent = pages.value + (pages.value === "1" ? " page" : " pages");
    if (state.me && !state.me.unlimited && state.me.usageLeft <= 0) {
      $("formError").textContent = "You have used all of your free presentations.";
      $("formError").hidden = false;
    }
    dialog.showModal();
  }
  $("newBtn").addEventListener("click", openDialog);
  $("emptyNewBtn").addEventListener("click", openDialog);
  $("cancelBtn").addEventListener("click", function () { dialog.close(); });

  function startBuildView() {
    buildState.slides = 0;
    $("createFields").hidden = true;
    $("buildView").hidden = false;
    $("buildTitle").textContent = "";
    $("buildStatus").textContent = "Starting\u2026";
    $("buildSlides").innerHTML = "";
    applyTheme($("buildSlides"), null);
    $("buildClose").hidden = true;
  }

  function resetCreateView() {
    $("createFields").hidden = false;
    $("buildView").hidden = true;
  }

  function buildError(message) {
    $("buildStatus").textContent = message || "Something went wrong. Try again.";
    $("buildClose").hidden = false;
  }

  function handleBuildEvent(evt) {
    if (evt.type === "meta") {
      if (evt.title) $("buildTitle").textContent = evt.title;
      if (evt.theme) applyTheme($("buildSlides"), evt.theme);
    } else if (evt.type === "slide") {
      $("buildSlides").appendChild(slideCard(evt.slide, evt.index || buildState.slides));
      buildState.slides += 1;
      var box = $("buildSlides");
      box.scrollTop = box.scrollHeight;
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

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var invitees = $("invitees").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var payload = { invitees: invitees, details: $("details").value, pages: Number(pages.value) };
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
