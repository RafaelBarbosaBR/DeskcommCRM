/**
 * O tracker.js instalável — UM script por site (item 1 do pedido). JS puro,
 * sem bundler, sem imports: roda direto no site do cliente via
 * `<script src=".../t.js" data-site="{site_key}" async>`. Servido por
 * `app/api/v1/track/t.js/route.ts`.
 *
 * Regras não-negociáveis deste arquivo (repita ao editar):
 *  - Nunca `preventDefault()` em submit de formulário nem em clique de link —
 *    o comportamento original do site nunca é bloqueado (item 3).
 *  - Clique de WhatsApp é SÓ detecção de clique: nunca lê o conteúdo da
 *    conversa, nunca manda contact_id/lead_id (item 3).
 *  - fbclid/gclid/gbraid/wbraid/UTM: só manda o que leu da própria URL —
 *    nunca inventa quando ausente (item 1).
 *  - `_fbc` segue a spec oficial da Meta: `fb.1.<creation_time_ms>.<fbclid>`.
 *    A lógica espelha `lib/rastreamento/captura/logica.ts` (testada) —
 *    mantenha as duas em sincronia.
 */
export const TRACKER_JS_SOURCE = `(function () {
  "use strict";
  var script = document.currentScript;
  var site = script && script.getAttribute("data-site");
  if (!site) return;
  var API_BASE = script.src.replace(/\\/t\\.js.*$/, "");

  function uuidv4() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCookie(name) {
    var m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function setCookie(name, value, maxAgeSeconds) {
    document.cookie = name + "=" + encodeURIComponent(value) + "; path=/; max-age=" + maxAgeSeconds + "; SameSite=Lax";
  }

  var VISITOR_MAX_AGE = 400 * 24 * 60 * 60;
  var SESSION_MAX_AGE = 30 * 60;
  var FBC_MAX_AGE = 90 * 24 * 60 * 60;

  var visitorId = getCookie("_dc_vid") || uuidv4();
  setCookie("_dc_vid", visitorId, VISITOR_MAX_AGE);

  var sessionId = getCookie("_dc_sid") || uuidv4();
  setCookie("_dc_sid", sessionId, SESSION_MAX_AGE);

  function param(name) {
    try {
      return new URL(location.href).searchParams.get(name);
    } catch (e) {
      return null;
    }
  }

  var fbclid = param("fbclid");
  var gclid = param("gclid");
  var gbraid = param("gbraid");
  var wbraid = param("wbraid");
  var utm_source = param("utm_source");
  var utm_medium = param("utm_medium");
  var utm_campaign = param("utm_campaign");
  var utm_term = param("utm_term");
  var utm_content = param("utm_content");

  // Nunca inventa: sem fbclid novo E sem _fbc de visita anterior, fica null.
  var fbc = getCookie("_fbc");
  if (fbclid) {
    fbc = "fb.1." + Date.now() + "." + fbclid;
    setCookie("_fbc", fbc, FBC_MAX_AGE);
  }

  var config = null;
  function carregarConfig(cb) {
    fetch(API_BASE + "/" + site + "/config")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { config = j; cb(); })
      .catch(function () { cb(); });
  }

  function beacon(payload) {
    var body = JSON.stringify(payload);
    var url = API_BASE + "/" + site + "/collect";
    if (navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
    } else {
      fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body, keepalive: true });
    }
  }

  function ackPixel(eventId) {
    try {
      fetch(API_BASE + "/" + site + "/pixel-ack", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ event_id: eventId }),
        keepalive: true,
      });
    } catch (e) {}
  }

  var fbqCarregado = false;
  function carregarFbq(cb) {
    if (fbqCarregado) { cb(); return; }
    fbqCarregado = true;
    (function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = true; n.version = "2.0"; n.queue = [];
      t = b.createElement(e); t.async = true; t.src = v;
      s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    })(window, document, "script", "https://connect.facebook.net/en_US/fbevents.js");
    cb();
  }

  var gtagIds = {};
  function carregarGtag(id, cb) {
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function () { window.dataLayer.push(arguments); };
    }
    if (!gtagIds[id]) {
      gtagIds[id] = true;
      var s = document.createElement("script");
      s.async = true;
      s.src = "https://www.googletagmanager.com/gtag/js?id=" + id;
      document.head.appendChild(s);
      window.gtag("js", new Date());
    }
    cb();
  }

  // Pixel/gtag client-side SÓ pros eventos que acontecem com o visitante
  // ainda na página (page_view/contact) — LEAD/QUALIFIED/PURCHASE nascem
  // dias depois no pipeline do CRM, sem browser nenhum vivo pra disparar
  // nada; esses vão só pelo servidor (despacho.handler.ts).
  function dispararClientSide(tipo, eventId) {
    if (!config) return;
    var ehContato = tipo === "form_submit" || tipo === "whatsapp_click";
    var nomeMeta = tipo === "page_view" ? "PageView" : "Contact";

    if (config.meta_pixel_id) {
      carregarFbq(function () {
        window.fbq("init", config.meta_pixel_id);
        window.fbq("trackSingle", config.meta_pixel_id, nomeMeta, {}, { eventID: eventId });
        ackPixel(eventId);
      });
    }
    if (config.ga4_measurement_id) {
      carregarGtag(config.ga4_measurement_id, function () {
        window.gtag("config", config.ga4_measurement_id, { send_page_view: tipo === "page_view" });
        if (ehContato) window.gtag("event", "contact");
      });
    }
    if (config.google_ads_conversion_id && ehContato) {
      carregarGtag(config.google_ads_conversion_id, function () {
        window.gtag("config", config.google_ads_conversion_id);
        var sendTo = config.google_ads_conversion_id + (config.google_ads_contact_label ? "/" + config.google_ads_contact_label : "");
        window.gtag("event", "conversion", { send_to: sendTo });
      });
    }
  }

  function registrar(tipo, extra) {
    var eventId = uuidv4();
    var payload = {
      type: tipo,
      event_id: eventId,
      visitor_id: visitorId,
      session_id: sessionId,
      url: location.href,
      referrer: document.referrer || null,
      utm_source: utm_source, utm_medium: utm_medium, utm_campaign: utm_campaign,
      utm_term: utm_term, utm_content: utm_content,
      fbclid: fbclid, fbc: fbc, gclid: gclid, gbraid: gbraid, wbraid: wbraid,
    };
    for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
    beacon(payload);
    dispararClientSide(tipo, eventId);
  }

  carregarConfig(function () {
    registrar("page_view");
  });

  var ALIASES = {
    email: ["email", "e-mail", "mail"],
    phone: ["phone", "telefone", "whatsapp", "celular", "phone_number", "tel"],
    name: ["name", "nome", "full_name", "fullname"],
  };
  function campoDoFormulario(form, aliases) {
    for (var i = 0; i < aliases.length; i++) {
      var seletor = '[name="' + aliases[i] + '"], [id="' + aliases[i] + '"]';
      var el = form.querySelector(seletor);
      if (el && el.value) return el.value;
    }
    return null;
  }

  // Captura: nunca preventDefault — o formulário segue pro destino original
  // dele (o webhook de captação do CRM, ou o backend do próprio cliente).
  document.addEventListener(
    "submit",
    function (ev) {
      var form = ev.target;
      if (!form || form.tagName !== "FORM") return;
      registrar("form_submit", {
        email: campoDoFormulario(form, ALIASES.email),
        phone: campoDoFormulario(form, ALIASES.phone),
        name: campoDoFormulario(form, ALIASES.name),
      });
    },
    true,
  );

  var RE_WA_HTTP = /^(?:https?:)?\\/\\/(?:[a-z0-9-]+\\.)?(?:wa\\.me|whatsapp\\.com)(?:[/?#]|$)/i;
  var RE_WA_SCHEME = /^whatsapp:\\/\\//i;
  function ehLinkDeWhatsApp(href) {
    var alvo = (href || "").trim();
    return RE_WA_HTTP.test(alvo) || RE_WA_SCHEME.test(alvo);
  }

  // Detecção de clique, nunca leitura de conversa — sem contact_id/lead_id,
  // nunca preventDefault (o link abre o WhatsApp normalmente).
  document.addEventListener(
    "click",
    function (ev) {
      var el = ev.target;
      while (el && el.tagName !== "A") el = el.parentElement;
      if (!el) return;
      var href = el.getAttribute("href") || "";
      if (!ehLinkDeWhatsApp(href)) return;
      registrar("whatsapp_click", {});
    },
    true,
  );
})();
`;
