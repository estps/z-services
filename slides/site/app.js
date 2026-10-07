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
    q.appendChild(el("span", "quota-num", String(usage.left)));
    q.appendChild(el("span", "quota-label", usage.left === 1 ? "free deck left" : "free decks left"));
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
    if (!deck.canva) return;
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

  function openDialog() {
    $("formError").hidden = true;
    if (state.me && state.me.usageLeft <= 0) {
      $("formError").textContent = "You have used all of your free presentations.";
      $("formError").hidden = false;
    }
    dialog.showModal();
  }
  $("newBtn").addEventListener("click", openDialog);
  $("emptyNewBtn").addEventListener("click", openDialog);
  $("cancelBtn").addEventListener("click", function () { dialog.close(); });

  var pages = $("pages");
  pages.addEventListener("input", function () { $("pagesOut").textContent = pages.value + (pages.value === "1" ? " page" : " pages"); });

  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var btn = $("createBtn");
    var errBox = $("formError");
    errBox.hidden = true;
    btn.disabled = true;
    btn.textContent = "Generating… (up to 30s)";

    var invitees = $("invitees").value.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    api("/api/generate", {
      method: "POST",
      body: JSON.stringify({
        invitees: invitees,
        details: $("details").value,
        pages: Number(pages.value),
      }),
    }).then(function (data) {
      dialog.close();
      refresh().then(function () { openDeck(data.deck.id); });
    }).catch(function (err) {
      errBox.textContent = err.message || "Something went wrong. Try again.";
      errBox.hidden = false;
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "Generate deck";
    });
  });

  function refresh() {
    return Promise.all([api("/api/me"), api("/api/decks"), api("/api/canva/status")]).then(function (results) {
      state.me = results[0].user;
      state.me.usageLeft = results[0].usage.left;
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
