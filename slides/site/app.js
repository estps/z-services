/* Z Slides - front-end */
(function () {
  "use strict";

  var state = { me: null, decks: [], current: null };

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
    return Promise.all([api("/api/me"), api("/api/decks")]).then(function (results) {
      state.me = results[0].user;
      state.me.usageLeft = results[0].usage.left;
      state.decks = results[1].decks;
      renderAccount();
      renderQuota(results[0].usage);
      renderDeckList();
    });
  }

  refresh().then(function () {
    if (state.decks.length) openDeck(state.decks[0].id);
  }).catch(function () {
    window.location.href = "/auth/login";
  });
})();
