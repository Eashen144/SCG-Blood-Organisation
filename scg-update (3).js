/* =====================================================================
   S.C.G Blood Organisation — website update add-on
   ---------------------------------------------------------------------
   Adds, without touching the existing code in index.html:
     1. Donor auto-approval messaging (the approval itself happens in the
        database: submit_donor_registration + site_settings.auto_approve_donors)
     2. Admin "Setup & Settings": organisation info, donor / request
        switches and browser-based password change
     3. Ads Manager image upload (private Supabase Storage bucket
        "ads-images"), preview, edit/replace/remove and a responsive
        banner on the public site
     4. Tidier, centered public footer (emergency note, links, copyright
        and developer credit)

   Only the public (publishable) key from window.SCG_CONFIG is used.
   No password, service-role key or secret is stored in this file.
   To disable the add-on, remove its <script> line from index.html.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__scgUpdateLoaded) return;
  window.__scgUpdateLoaded = true;

  var BUCKET = 'ads-images';
  var MAX_AD_IMAGE = 5 * 1024 * 1024;
  var MAX_LOGO_IMAGE = 2 * 1024 * 1024;
  var IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  var sb = null;
  var settings = null;       // latest public site_settings row
  var topAdHasImage = false; // newest live ad has an image -> banner replaces the popup
  var adsReady = null;       // resolves once the live ads have been looked at
  var adsCache = [];

  /* ------------------------------------------------------------------
     0. Tiny helpers
     ------------------------------------------------------------------ */

  function $(id) { return document.getElementById(id); }

  function esc(value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(message, kind) {
    var el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.className = 'toast'; }, kind === 'error' ? 6000 : 4000);
  }

  function fmtDateTime(value) {
    if (!value) return '—';
    var d = new Date(value);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function localValue(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d)) return '';
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function busy(button, on, label) {
    if (!button) return;
    if (on) {
      button.dataset.label = button.textContent;
      button.disabled = true;
      if (label) button.textContent = label;
    } else {
      button.disabled = false;
      if (button.dataset.label) button.textContent = button.dataset.label;
    }
  }

  function adminNotice(message) {
    var box = $('adminNotice');
    if (!box) return;
    if (!message) { box.hidden = true; box.textContent = ''; return; }
    box.textContent = message;
    box.hidden = false;
    try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* ignore */ }
  }

  function errMsg(error) {
    if (!error) return 'অজানা ত্রুটি';
    var m = error.message || String(error);
    if (/row-level security|permission denied|not authorized|jwt/i.test(m)) return 'এই কাজের অনুমতি নেই। আবার লগইন করে চেষ্টা করুন।';
    return m;
  }

  function isAdminRoute() {
    var param = new URLSearchParams(location.search).get('admin');
    if (param !== null && /^(|1|true)$/i.test(param)) return true;
    return location.pathname.replace(/\/+$/, '').endsWith('/admin');
  }

  function getClient() {
    if (sb) return sb;
    var cfg = window.SCG_CONFIG || {};
    if (!window.supabase || typeof window.supabase.createClient !== 'function') return null;
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_PUBLISHABLE_KEY) return null;
    // Same URL + key as the main app, so the logged-in admin session in
    // localStorage is shared. Token refresh is left to the main app.
    sb = window.supabase.createClient(cfg.SUPABASE_URL, String(cfg.SUPABASE_PUBLISHABLE_KEY).trim(), {
      auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false }
    });
    return sb;
  }

  async function currentUser() {
    var c = getClient();
    if (!c) return null;
    var r = await c.auth.getSession();
    return r && r.data && r.data.session ? r.data.session.user : null;
  }

  // Storage paths -> short-lived signed URLs (the bucket is private).
  async function signedUrls(paths) {
    var out = {};
    var need = [];
    (paths || []).forEach(function (p) {
      if (!p) return;
      if (/^https:\/\//i.test(p)) out[p] = p; else if (need.indexOf(p) === -1) need.push(p);
    });
    if (need.length && getClient()) {
      try {
        var r = await getClient().storage.from(BUCKET).createSignedUrls(need, 3600);
        ((r && r.data) || []).forEach(function (item) {
          if (item && item.signedUrl && item.path) out[item.path] = item.signedUrl;
        });
      } catch (e) { /* images are optional: never break the page */ }
    }
    return out;
  }

  async function uploadImage(file, folder, maxBytes) {
    var ext = IMAGE_TYPES[file.type];
    if (!ext) throw new Error('শুধু JPG, PNG বা WebP ছবি দিন।');
    if (file.size > maxBytes) throw new Error('ছবির আকার সর্বোচ্চ ' + Math.round(maxBytes / 1048576) + ' MB হতে পারে।');
    var id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID()
      : String(Date.now()) + Math.random().toString(16).slice(2);
    var path = folder + '/' + id + '.' + ext;
    var r = await getClient().storage.from(BUCKET).upload(path, file, {
      contentType: file.type, cacheControl: '3600', upsert: false
    });
    if (r.error) throw r.error;
    return path;
  }

  async function removeImage(path) {
    if (!path || /^https:\/\//i.test(path)) return;
    try { await getClient().storage.from(BUCKET).remove([path]); } catch (e) { /* best effort */ }
  }

  // Same modal shell the main app uses (#modalback / #modalContent).
  function openMyModal(title, html, onMount) {
    var back = $('modalback');
    if (!back) return;
    $('modalTitle').textContent = title;
    $('modalContent').innerHTML = html;
    back.classList.add('open');
    document.body.style.overflow = 'hidden';
    if (typeof onMount === 'function') onMount($('modalContent'));
    var focusTarget = $('modalContent').querySelector('input, select, textarea, button, a');
    (focusTarget || $('modalClose')).focus();
  }

  function closeMyModal() {
    var btn = $('modalClose');
    if (btn) btn.click();
  }

  function adState(ad) {
    var now = Date.now();
    var start = new Date(ad.starts_at || ad.created_at).getTime();
    var end = new Date(ad.ends_at).getTime();
    if (!ad.active) return { label: 'Disabled', cls: 'off' };
    if (start > now) return { label: 'Scheduled', cls: 'processing' };
    if (end <= now) return { label: 'Expired', cls: 'expired' };
    return { label: 'Live', cls: 'live' };
  }

  /* ------------------------------------------------------------------
     0b. Observe the donor-registration answer (for the success message)
     ------------------------------------------------------------------ */

  (function wrapFetch() {
    if (typeof window.fetch !== 'function') return;
    var original = window.fetch;
    window.fetch = function (input) {
      var promise = original.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/rpc/submit_donor_registration') !== -1) {
          window.__scgRegStatus = null;
          promise.then(function (response) {
            response.clone().json().then(function (json) {
              if (json && json.ok) window.__scgRegStatus = json.status || 'pending';
            }).catch(function () { /* ignore */ });
          }).catch(function () { /* ignore */ });
        }
      } catch (e) { /* never interfere with the request */ }
      return promise;
    };
  })();

  /* ------------------------------------------------------------------
     1. Styles
     ------------------------------------------------------------------ */

  function injectStyles() {
    if ($('scgUpdateStyles')) return;
    var css = [
      '.scg-banners{display:grid;gap:14px;margin-top:18px;margin-bottom:6px}',
      '.scg-ad{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm);overflow:hidden}',
      '.scg-ad img{display:block;width:100%;max-height:340px;object-fit:cover;background:var(--bg)}',
      '.scg-adtext{padding:14px 18px 18px}',
      '.scg-adtext h3{margin:0 0 6px;font-size:18px}',
      '.scg-adclose{position:absolute;top:8px;right:8px;width:32px;height:32px;border-radius:50%;border:0;background:rgba(24,17,27,.55);color:#fff;font-size:18px;line-height:1;cursor:pointer}',
      '.scg-adclose:focus-visible{outline:3px solid var(--focus);outline-offset:2px}',
      '@media (min-width:780px){.scg-ad.has-img{display:grid;grid-template-columns:1.25fr 1fr;align-items:stretch}.scg-ad.has-img img{height:100%;max-height:none;min-height:220px}.scg-adtext{align-self:center;padding:22px 26px}}',
      '.scg-thumb{display:block;width:72px;height:48px;object-fit:cover;border-radius:8px;border:1px solid var(--line);margin-bottom:6px;background:var(--bg)}',
      '.scg-preview{display:none;max-width:280px;max-height:170px;border-radius:12px;border:1px solid var(--line);margin-top:8px}',
      '.scg-preview.show{display:block}',
      '.scg-check{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line)}',
      '.scg-check:last-of-type{border-bottom:0}',
      '.scg-check input{margin-top:3px;width:18px;height:18px;accent-color:var(--red);flex:none}',
      '.scg-check b{display:block}',
      '.scg-logoprev{display:block;width:72px;height:72px;object-fit:cover;border-radius:16px;border:1px solid var(--line);margin-top:8px}',
      '.scg-dirnotice{margin:0 0 14px}',
      '.scg-groups{margin-top:18px;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow-sm);padding:16px 18px}',
      '.scg-groups h3{margin:0 0 12px;font-size:16px}',
      '.scg-grow{display:grid;grid-template-columns:42px 1fr 116px;align-items:center;gap:10px;padding:6px 0}',
      '.scg-gname{font-weight:800;color:var(--red);font-size:16px}',
      '.scg-gbar{position:relative;display:block;height:12px;border-radius:99px;background:var(--line);overflow:hidden}',
      '.scg-gbar i{position:absolute;left:0;top:0;bottom:0;border-radius:99px;display:block}',
      '.scg-gbar .t{background:#f4a9bb}',
      '.scg-gbar .a{background:var(--red)}',
      '.scg-gnum{font-size:13px;color:var(--muted);white-space:nowrap;text-align:right}',
      '.scg-gnum b{color:var(--ink)}',
      '.scg-glegend{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0 0;font-size:12px;color:var(--muted)}',
      '.scg-glegend span::before{content:"";display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}',
      '.scg-glegend .lt::before{background:#f4a9bb}',
      '.scg-glegend .la::before{background:var(--red)}',
      /* footer polish */
      '.scg-footer{padding:28px 0 34px}',
      '.scg-footer .footerin{flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:13px}',
      '.scg-footer .footerin>div{display:contents}',
      '.scg-footer .scg-femg{order:1;display:inline-flex;align-items:center;gap:9px;max-width:100%;background:#fff0f3;border:1px solid var(--line-strong);color:var(--red-strong);border-radius:999px;padding:7px 15px;line-height:1.5;font-size:12.5px;margin:0}',
      '.scg-footer .scg-femg::before{content:"";flex:none;height:7px;width:7px;border-radius:50%;background:var(--red-soft);box-shadow:0 0 0 4px #ffe0e8}',
      '.scg-footer nav{order:2;justify-content:center;gap:4px 6px}',
      '.scg-footer nav a,.scg-footer nav .linkbtn{padding:5px 11px;border-radius:999px;transition:color .16s,background-color .16s}',
      '.scg-footer nav a:hover,.scg-footer nav .linkbtn:hover{background:#fff0f3;text-decoration:none}',
      '.scg-footer .scg-fcopy{order:3;font-size:12px;margin:0}',
      '.scg-footer .scg-fcredit{order:4;font-size:11.5px;color:#8b8290;margin:-6px 0 0}'
    ].join('\n');
    var style = document.createElement('style');
    style.id = 'scgUpdateStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------
     2. Public site
     ------------------------------------------------------------------ */

  async function loadSettings() {
    var c = getClient();
    if (!c) return null;
    try {
      var r = await c.from('site_settings').select('*').eq('id', 1).maybeSingle();
      if (r.error || !r.data) return null;
      settings = r.data;
      return settings;
    } catch (e) { return null; }
  }

  // Footer: emergency note on top, links, then copyright and developer credit.
  function polishFooter() {
    var footer = document.querySelector('.footer');
    var inner = footer ? footer.querySelector('.footerin') : null;
    if (!inner) return;
    footer.classList.add('scg-footer');

    var block = null;
    Array.prototype.forEach.call(inner.children, function (el) {
      if (!block && el.tagName === 'DIV') block = el;
    });
    var copy = null;
    var emergency = null;
    if (block) {
      copy = block.children[0] || null;
      Array.prototype.forEach.call(block.children, function (el) {
        if (el !== copy && el.textContent.indexOf('জরুরি') !== -1) emergency = el;
      });
    }
    if (copy) copy.classList.add('scg-fcopy');
    if (emergency) emergency.classList.add('scg-femg');

    var yearEl = $('year');
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    if (!$('scgFooterCredit') && footer.textContent.indexOf('Bluewave') === -1) {
      var credit = document.createElement('div');
      credit.id = 'scgFooterCredit';
      credit.className = 'scg-fcredit';
      credit.textContent = 'developed by Bluewave Media Team - BMT';
      inner.appendChild(credit);
    }
  }

  async function applyPublicSettings(s) {
    // organisation name + footer
    var name = (s.org_name || '').trim();
    var brand = document.querySelector('.nav .brand');
    if (name && brand && brand.children[1]) brand.children[1].textContent = name;
    var footerLine = document.querySelector('.footer .footerin > div > div');
    if (name && footerLine) {
      var yearEl = $('year');
      var year = yearEl ? yearEl.textContent : String(new Date().getFullYear());
      footerLine.innerHTML = '© <span id="year">' + esc(year) + '</span> ' + esc(name) + '.';
    }
    if (name) document.title = name;

    // logo (storage path or https URL)
    if (s.logo_url && brand) {
      var urls = await signedUrls([s.logo_url]);
      var src = urls[s.logo_url];
      var logo = brand.querySelector('.logo');
      if (src && logo) {
        logo.innerHTML = '<img alt="" src="' + esc(src) + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block">';
      }
    }

    // contact block
    var target = $('contactDetails');
    if (target) {
      var rows = [];
      if (s.contact_email) rows.push('<a href="mailto:' + esc(s.contact_email) + '">' + esc(s.contact_email) + '</a>');
      if (s.contact_number) rows.push('<a href="tel:' + esc(String(s.contact_number).replace(/[^\d+]/g, '')) + '">' + esc(s.contact_number) + '</a>');
      if (s.address) rows.push(esc(s.address));
      if (rows.length) target.innerHTML = rows.join('<br>');
    }

    // about text
    if (s.about_org) {
      var about = document.querySelector('#about .sectionhead p:not(.eyebrow)');
      if (about) { about.textContent = s.about_org; about.style.whiteSpace = 'pre-wrap'; }
    }

    // auto approval wording
    if (s.auto_approve_donors) {
      Array.prototype.forEach.call(document.querySelectorAll('#about .feature p'), function (p) {
        if (p.textContent.indexOf('অ্যাডমিন যাচাইয়ের পর আপনার তথ্য') !== -1) {
          p.textContent = 'নিজের তথ্য দিয়ে নিবন্ধন করুন। নিবন্ধন সম্পন্ন হলেই আপনার তথ্য তালিকায় প্রকাশিত হবে।';
        }
      });
    }

    // directory switched off
    if (s.donor_directory_public === false && !$('scgDirNotice')) {
      var form = $('searchForm');
      if (form) {
        var note = document.createElement('div');
        note.id = 'scgDirNotice';
        note.className = 'noticebox scg-dirnotice';
        note.setAttribute('role', 'status');
        note.textContent = 'ডোনার তালিকা সাময়িকভাবে বন্ধ আছে। অনুগ্রহ করে পরে আবার দেখুন।';
        form.parentNode.insertBefore(note, form);
      }
    }
  }

  async function loadBanners() {
    var c = getClient();
    if (!c) return;
    try {
      var now = new Date().toISOString();
      var r = await c.from('ads')
        .select('id,title,body,button_text,button_url,image_url,created_at')
        .eq('active', true)
        .or('starts_at.is.null,starts_at.lte.' + now)
        .gt('ends_at', now)
        .order('created_at', { ascending: false })
        .limit(5);
      if (r.error || !r.data || !r.data.length) return;
      topAdHasImage = !!r.data[0].image_url;
      var ads = r.data.filter(function (a) { return a.image_url; }).slice(0, 3);
      ads = ads.filter(function (a) { return !sessionStorage.getItem('scg_banner_closed_' + a.id); });
      if (!ads.length) return;
      var urls = await signedUrls(ads.map(function (a) { return a.image_url; }));
      var cards = ads.map(function (a) {
        var src = urls[a.image_url];
        if (!src) return '';
        var safeUrl = /^https:\/\//i.test(a.button_url || '') ? a.button_url : '';
        return '<article class="scg-ad has-img" data-ad="' + esc(a.id) + '">' +
          '<img src="' + esc(src) + '" alt="' + esc(a.title) + '" loading="eager">' +
          '<div class="scg-adtext"><p class="eyebrow" style="margin-bottom:8px">ANNOUNCEMENT</p>' +
          '<h3>' + esc(a.title) + '</h3>' +
          (a.body ? '<div class="adbody">' + esc(a.body) + '</div>' : '') +
          (safeUrl ? '<p style="margin:14px 0 0"><a class="btn small" href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' +
            esc(a.button_text || 'Learn more') + '</a></p>' : '') +
          '</div>' +
          '<button class="scg-adclose" type="button" data-close-ad="' + esc(a.id) + '" aria-label="বন্ধ করুন">×</button>' +
          '</article>';
      }).join('');
      if (!cards) return;
      var main = $('main');
      if (!main) return;
      var box = document.createElement('section');
      box.className = 'wrap scg-banners';
      box.id = 'scgAdBanner';
      box.setAttribute('aria-label', 'ঘোষণা');
      box.innerHTML = cards;
      var hero = main.querySelector('.hero');
      if (hero) main.insertBefore(box, hero); else main.appendChild(box);
      box.addEventListener('click', function (event) {
        var btn = event.target.closest ? event.target.closest('[data-close-ad]') : null;
        if (!btn) return;
        try { sessionStorage.setItem('scg_banner_closed_' + btn.dataset.closeAd, '1'); } catch (e) { /* ignore */ }
        var card = btn.closest('.scg-ad');
        if (card) card.remove();
        if (!box.children.length) box.remove();
      });
    } catch (e) { /* ads are non-critical */ }
  }

  function bindPublicExtras() {
    // Blood requests switched off -> block the form (the database refuses them too).
    document.addEventListener('click', function (event) {
      var t = event.target && event.target.closest ? event.target.closest('[data-action="open-request"]') : null;
      if (!t || !settings || settings.requests_public !== false) return;
      event.preventDefault();
      event.stopPropagation();
      openMyModal('🩸 রক্তের অনুরোধ',
        '<div class="state"><h3>অনুরোধ গ্রহণ সাময়িকভাবে বন্ধ</h3>' +
        '<p class="small">এই মুহূর্তে ওয়েবসাইট থেকে নতুন রক্তের অনুরোধ নেওয়া হচ্ছে না। জরুরি প্রয়োজনে নিকটস্থ হাসপাতাল বা জরুরি সেবায় যোগাযোগ করুন।</p>' +
        '<button class="btn light small" type="button" id="scgReqClose">ঠিক আছে</button></div>',
        function (root) { root.querySelector('#scgReqClose').addEventListener('click', closeMyModal); });
    }, true);

    // Modal text fixes + banner replaces the popup for image ads.
    var content = $('modalContent');
    var back = $('modalback');
    if (content) {
      new MutationObserver(function () { fixModalTexts(); }).observe(content, { childList: true, subtree: true });
    }
    if (back) {
      var dropPopup = function () {
        if (!back.classList.contains('open') || !topAdHasImage) return;
        var title = $('modalTitle');
        if (title && title.textContent === 'ঘোষণা' && $('modalContent').querySelector('.adbody')) closeMyModal();
      };
      new MutationObserver(function () {
        if (!back.classList.contains('open')) return;
        var title = $('modalTitle');
        if (!title || title.textContent !== 'ঘোষণা' || !$('modalContent').querySelector('.adbody')) return;
        // The ad popup opened: if the newest ad has an image the banner already shows it.
        if (adsReady) adsReady.then(dropPopup); else dropPopup();
      }).observe(back, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function fixModalTexts() {
    var root = $('modalContent');
    if (!root || !settings || !settings.auto_approve_donors) return;

    var done = root.querySelector('#regDone');
    if (done && !done.dataset.scgSeen) { done.dataset.scgSeen = '1'; refreshGroupStatsSoon(); }
    if (done && !done.dataset.scgFixed) {
      var apply = function () {
        var status = window.__scgRegStatus;
        var card = done.closest('.state');
        if (!card || done.dataset.scgFixed) return false;
        if (status === 'approved') {
          var h = card.querySelector('h3');
          var p = card.querySelector('p');
          if (h) h.textContent = 'নিবন্ধন সম্পন্ন হয়েছে ✓';
          if (p) {
            p.textContent = settings.donor_directory_public === false
              ? 'আপনার নিবন্ধন সম্পন্ন হয়েছে। ধন্যবাদ!'
              : 'আপনার নিবন্ধন সম্পন্ন হয়েছে এবং আপনার নাম এখন ডোনার তালিকায় দেখা যাবে। ধন্যবাদ!';
          }
          done.dataset.scgFixed = '1';
          return true;
        }
        if (status === 'pending') done.dataset.scgFixed = '1';
        return false;
      };
      if (!apply()) {
        setTimeout(function () { if (document.body.contains(done)) apply(); }, 450);
      }
    }

    Array.prototype.forEach.call(root.querySelectorAll('p'), function (p) {
      if (p.textContent.indexOf('নতুন নিবন্ধন স্বয়ংক্রিয়ভাবে প্রকাশিত হয় না') !== -1) {
        p.innerHTML = '<b>অনুমোদন:</b> নিবন্ধনের পর আপনার তথ্য স্বয়ংক্রিয়ভাবে ডোনার তালিকায় প্রকাশিত হয়। অ্যাডমিন যেকোনো সময় তথ্য পর্যালোচনা বা তালিকা থেকে সরাতে পারেন।';
      }
    });
  }

  // Donors per blood group (approved donors; "ready" = currently available).
  var groupsTimer = null;

  function bn(n) {
    try { return Number(n).toLocaleString('bn-BD'); } catch (e) { return String(n); }
  }

  async function loadGroupStats() {
    var c = getClient();
    var anchor = document.querySelector('.hero .stats');
    if (!c || !anchor) return;
    try {
      var r = await c.rpc('public_blood_group_stats');
      var payload = r && r.data;
      if (r.error || !payload || !payload.ok || !payload.groups) return;
      var groups = payload.groups;
      var max = 0;
      groups.forEach(function (g) { if (g.total > max) max = g.total; });
      var rows = groups.map(function (g) {
        var tw = max ? Math.round((g.total / max) * 100) : 0;
        if (g.total > 0 && tw < 4) tw = 4;
        var aw = g.total ? Math.round((g.available / g.total) * tw) : 0;
        if (g.available > 0 && aw < 3) aw = 3;
        return '<div class="scg-grow">' +
          '<span class="scg-gname">' + esc(g.blood_group) + '</span>' +
          '<span class="scg-gbar" aria-hidden="true"><i class="t" style="width:' + tw + '%"></i><i class="a" style="width:' + aw + '%"></i></span>' +
          '<span class="scg-gnum"><b>' + bn(g.total) + ' জন</b> · ' + bn(g.available) + ' প্রস্তুত</span>' +
          '</div>';
      }).join('');
      var box = $('scgGroups');
      if (!box) {
        box = document.createElement('div');
        box.id = 'scgGroups';
        box.className = 'scg-groups';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'রক্তের গ্রুপ অনুযায়ী ডোনার');
        anchor.insertAdjacentElement('afterend', box);
      }
      box.innerHTML = '<h3>রক্তের গ্রুপ অনুযায়ী ডোনার</h3>' + rows +
        '<p class="scg-glegend"><span class="lt">নিবন্ধিত ডোনার</span><span class="la">রক্ত দিতে প্রস্তুত</span></p>';
    } catch (e) { /* statistics are non-critical */ }
  }

  function refreshGroupStatsSoon() {
    clearTimeout(groupsTimer);
    groupsTimer = setTimeout(loadGroupStats, 700);
  }

  async function initPublic() {
    adsReady = loadBanners();
    loadGroupStats();
    bindPublicExtras();
    polishFooter();
    var s = await loadSettings();
    if (s) await applyPublicSettings(s);
    polishFooter();
  }

  /* ------------------------------------------------------------------
     3. Admin: Ads Manager (image upload, preview, edit, list)
     ------------------------------------------------------------------ */

  function bindImagePreview(input, img) {
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) { img.classList.remove('show'); img.removeAttribute('src'); return; }
      if (!IMAGE_TYPES[file.type]) {
        adminNotice('শুধু JPG, PNG বা WebP ছবি দিন।');
        input.value = '';
        img.classList.remove('show');
        return;
      }
      if (file.size > MAX_AD_IMAGE) {
        adminNotice('ছবির আকার সর্বোচ্চ ৫ MB হতে পারে।');
        input.value = '';
        img.classList.remove('show');
        return;
      }
      adminNotice('');
      img.src = URL.createObjectURL(file);
      img.classList.add('show');
    });
  }

  function injectAdImageField() {
    var form = $('adForm');
    if (!form || $('adImage')) return;
    var row = form.querySelector('.full.row');
    var field = document.createElement('div');
    field.className = 'field full';
    field.innerHTML =
      '<label for="adImage">বিজ্ঞাপনের ছবি (ঐচ্ছিক)</label>' +
      '<input id="adImage" type="file" accept="image/jpeg,image/png,image/webp">' +
      '<span class="hint">JPG, PNG বা WebP, সর্বোচ্চ ৫ MB। ছবি ওয়েবসাইটে ব্যানার হিসেবে দেখানো হবে।</span>' +
      '<img id="adImagePreview" class="scg-preview" alt="ছবির প্রিভিউ">';
    if (row) form.insertBefore(field, row); else form.appendChild(field);
    bindImagePreview($('adImage'), $('adImagePreview'));
  }

  function readNewAdForm() {
    var title = $('adTitle').value.trim();
    var body = $('adText').value.trim();
    var startRaw = $('adStart').value;
    var endRaw = $('adEnd').value;
    var buttonText = $('adButton').value.trim();
    var buttonUrl = $('adUrl').value.trim();
    var errors = [];
    if (title.length < 2) errors.push('শিরোনাম লিখুন।');
    if (body.length < 2) errors.push('বার্তা লিখুন।');
    if (!endRaw) errors.push('শেষের সময় দিন।');
    if (buttonUrl && !/^https:\/\//i.test(buttonUrl)) errors.push('বাটন URL অবশ্যই https:// দিয়ে শুরু হতে হবে।');
    var start = startRaw ? new Date(startRaw) : new Date();
    var end = endRaw ? new Date(endRaw) : null;
    if (end && end <= start) errors.push('শেষের সময় শুরুর পরে হতে হবে।');
    return {
      errors: errors,
      row: {
        title: title, body: body,
        starts_at: start.toISOString(),
        ends_at: end ? end.toISOString() : null,
        button_text: buttonText || null,
        button_url: buttonUrl || null
      }
    };
  }

  async function saveNewAd(event) {
    event.preventDefault();
    event.stopPropagation();
    var parsed = readNewAdForm();
    if (parsed.errors.length) { adminNotice(parsed.errors.join(' ')); return; }
    var button = $('adSaveBtn');
    busy(button, true, 'সংরক্ষণ হচ্ছে…');
    var uploaded = null;
    try {
      var file = $('adImage').files && $('adImage').files[0];
      if (file) uploaded = await uploadImage(file, 'ads', MAX_AD_IMAGE);
      var row = Object.assign({ active: true, image_url: uploaded }, parsed.row);
      var r = await getClient().from('ads').insert(row);
      if (r.error) throw r.error;
      adminNotice('');
      $('adForm').reset();
      var prev = $('adImagePreview');
      if (prev) { prev.classList.remove('show'); prev.removeAttribute('src'); }
      toast('বিজ্ঞাপন সংরক্ষিত হয়েছে', 'success');
      renderAdsList();
    } catch (error) {
      if (uploaded) removeImage(uploaded);
      adminNotice('সংরক্ষণ হয়নি: ' + errMsg(error));
    } finally {
      busy(button, false);
    }
  }

  function previewNewAd(event) {
    event.preventDefault();
    event.stopPropagation();
    var title = $('adTitle').value.trim() || '(শিরোনাম)';
    var body = $('adText').value.trim();
    var file = $('adImage').files && $('adImage').files[0];
    var buttonUrl = $('adUrl').value.trim();
    var safeUrl = /^https:\/\//i.test(buttonUrl) ? buttonUrl : '';
    var imgHtml = file && IMAGE_TYPES[file.type] ? '<img class="scg-preview show" style="max-width:100%;max-height:260px;margin:0 0 12px" alt="" src="' + esc(URL.createObjectURL(file)) + '">' : '';
    openMyModal('বিজ্ঞাপন প্রিভিউ',
      imgHtml +
      '<p class="eyebrow" style="margin-bottom:12px">ANNOUNCEMENT</p>' +
      '<h3 style="margin:0 0 8px">' + esc(title) + '</h3>' +
      '<div class="adbody">' + esc(body) + '</div>' +
      (safeUrl ? '<p style="margin-top:14px"><span class="btn">' + esc($('adButton').value.trim() || 'Learn more') + '</span></p>' : ''));
  }

  async function renderAdsList() {
    var box = $('adminAds');
    var c = getClient();
    if (!box || !c) return;
    var r = await c.from('ads')
      .select('id,title,body,starts_at,ends_at,button_text,button_url,active,created_at,image_url')
      .order('created_at', { ascending: false })
      .limit(100);
    if (r.error) {
      box.innerHTML = '<div class="scg-adslist noticebox" role="alert">বিজ্ঞাপন লোড করা যায়নি: ' + esc(errMsg(r.error)) + '</div>';
      return;
    }
    adsCache = r.data || [];
    if (!adsCache.length) {
      box.innerHTML = '<div class="scg-adslist"><div class="state"><h3>এখনো কোনো বিজ্ঞাপন নেই</h3><p class="small">উপরের ফর্ম থেকে প্রথম বিজ্ঞাপন তৈরি করুন।</p></div></div>';
      return;
    }
    var urls = await signedUrls(adsCache.map(function (a) { return a.image_url; }));
    var body = adsCache.map(function (ad) {
      var st = adState(ad);
      var thumb = ad.image_url && urls[ad.image_url]
        ? '<img class="scg-thumb" alt="" src="' + esc(urls[ad.image_url]) + '">' : '';
      var text = ad.body || '';
      return '<tr>' +
        '<td data-label="বিজ্ঞাপন">' + thumb + '<b>' + esc(ad.title) + '</b><br><span class="small muted">' +
        esc(text.length > 70 ? text.slice(0, 70) + '…' : text) + '</span></td>' +
        '<td data-label="সময়">' + esc(fmtDateTime(ad.starts_at)) + '<br><span class="tiny muted">পর্যন্ত ' + esc(fmtDateTime(ad.ends_at)) + '</span></td>' +
        '<td data-label="Status"><span class="badge ' + st.cls + '">' + st.label + '</span></td>' +
        '<td data-label="Actions"><div class="actions">' +
        '<button class="btn small light" type="button" data-x-preview="' + esc(ad.id) + '">প্রিভিউ</button>' +
        '<button class="btn small light" type="button" data-x-edit="' + esc(ad.id) + '">Edit</button>' +
        '<button class="btn small light" type="button" data-x-toggle="' + esc(ad.id) + '">' + (ad.active ? 'Disable' : 'Enable') + '</button>' +
        '<button class="btn small danger" type="button" data-x-delete="' + esc(ad.id) + '">Delete</button>' +
        '</div></td></tr>';
    }).join('');
    box.innerHTML = '<div class="scg-adslist"><table class="table"><thead><tr><th>Ad</th><th>Schedule</th><th>Status</th><th>Actions</th></tr></thead><tbody>' +
      body + '</tbody></table></div>';
  }

  function findAd(id) {
    return adsCache.filter(function (a) { return a.id === id; })[0];
  }

  async function previewSavedAd(id) {
    var ad = findAd(id);
    if (!ad) return;
    var urls = await signedUrls([ad.image_url]);
    var src = ad.image_url ? urls[ad.image_url] : '';
    var safeUrl = /^https:\/\//i.test(ad.button_url || '') ? ad.button_url : '';
    openMyModal('বিজ্ঞাপন প্রিভিউ',
      (src ? '<img class="scg-preview show" style="max-width:100%;max-height:260px;margin:0 0 12px" alt="" src="' + esc(src) + '">' : '') +
      '<p class="eyebrow" style="margin-bottom:12px">ANNOUNCEMENT</p>' +
      '<h3 style="margin:0 0 8px">' + esc(ad.title) + '</h3>' +
      '<div class="adbody">' + esc(ad.body || '') + '</div>' +
      (safeUrl ? '<p style="margin-top:14px"><a class="btn" href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + esc(ad.button_text || 'Learn more') + '</a></p>' : '') +
      '<p class="tiny muted" style="margin-top:14px">ওয়েবসাইটে ' + esc(fmtDateTime(ad.starts_at)) + ' থেকে ' + esc(fmtDateTime(ad.ends_at)) + ' পর্যন্ত দেখানো হবে।</p>');
  }

  async function toggleAd(id) {
    var ad = findAd(id);
    if (!ad) return;
    var r = await getClient().from('ads').update({ active: !ad.active }).eq('id', id).select('id');
    if (r.error || !r.data || !r.data.length) { adminNotice('আপডেট হয়নি: ' + errMsg(r.error)); return; }
    toast(ad.active ? 'বিজ্ঞাপন বন্ধ করা হয়েছে' : 'বিজ্ঞাপন চালু করা হয়েছে', 'success');
    renderAdsList();
  }

  async function deleteAd(id) {
    var ad = findAd(id);
    if (!ad) return;
    if (!window.confirm('এই বিজ্ঞাপনটি মুছে ফেলবেন? এটি আর ফেরানো যাবে না।')) return;
    var r = await getClient().from('ads').delete().eq('id', id).select('id');
    if (r.error || !r.data || !r.data.length) { adminNotice('মুছে ফেলা যায়নি: ' + errMsg(r.error)); return; }
    removeImage(ad.image_url);
    toast('বিজ্ঞাপন মুছে ফেলা হয়েছে', 'success');
    renderAdsList();
  }

  async function openEditAd(id) {
    var ad = findAd(id);
    if (!ad) return;
    var urls = await signedUrls([ad.image_url]);
    var cur = ad.image_url ? urls[ad.image_url] : '';
    var html =
      '<form id="scgEditAd" novalidate><div class="formgrid">' +
      '<div class="field"><label for="ea-title">শিরোনাম</label><input id="ea-title" value="' + esc(ad.title) + '" maxlength="120" required></div>' +
      '<div class="field"><label for="ea-active">অবস্থা</label><select id="ea-active"><option value="true"' + (ad.active ? ' selected' : '') + '>Active</option><option value="false"' + (ad.active ? '' : ' selected') + '>Disabled</option></select></div>' +
      '<div class="field full"><label for="ea-body">বার্তা</label><textarea id="ea-body" rows="3" maxlength="2000" required>' + esc(ad.body || '') + '</textarea></div>' +
      '<div class="field"><label for="ea-start">শুরুর সময়</label><input id="ea-start" type="datetime-local" value="' + localValue(ad.starts_at) + '" required></div>' +
      '<div class="field"><label for="ea-end">শেষের সময়</label><input id="ea-end" type="datetime-local" value="' + localValue(ad.ends_at) + '" required></div>' +
      '<div class="field"><label for="ea-btext">বাটন টেক্সট</label><input id="ea-btext" value="' + esc(ad.button_text || '') + '" maxlength="40"></div>' +
      '<div class="field"><label for="ea-burl">বাটন URL</label><input id="ea-burl" type="url" value="' + esc(ad.button_url || '') + '" placeholder="https://…"></div>' +
      '<div class="field full"><label for="ea-image">ছবি</label>' +
      (cur ? '<img id="ea-current" class="scg-preview show" alt="বর্তমান ছবি" src="' + esc(cur) + '">' : '<span class="hint">এখন কোনো ছবি নেই।</span>') +
      '<input id="ea-image" type="file" accept="image/jpeg,image/png,image/webp" style="margin-top:8px">' +
      '<span class="hint">নতুন ছবি বাছাই করলে আগেরটি বদলে যাবে। JPG, PNG বা WebP, সর্বোচ্চ ৫ MB।</span>' +
      '<img id="ea-new" class="scg-preview" alt="নতুন ছবির প্রিভিউ">' +
      (cur ? '<label class="scg-check" style="border:0;padding:6px 0 0"><input type="checkbox" id="ea-remove"><span>বর্তমান ছবি সরিয়ে দিন</span></label>' : '') +
      '</div>' +
      '<div class="noticebox full" id="ea-notice" role="alert" hidden></div>' +
      '<div class="full row"><button class="btn" type="submit" id="ea-save">সংরক্ষণ</button>' +
      '<button class="btn ghost" type="button" id="ea-cancel">বাতিল</button></div>' +
      '</div></form>';
    openMyModal('বিজ্ঞাপন সম্পাদনা', html, function (root) {
      root.querySelector('#ea-cancel').addEventListener('click', closeMyModal);
      var fileInput = root.querySelector('#ea-image');
      var newImg = root.querySelector('#ea-new');
      fileInput.addEventListener('change', function () {
        var notice = root.querySelector('#ea-notice');
        var file = fileInput.files && fileInput.files[0];
        notice.hidden = true;
        if (!file) { newImg.classList.remove('show'); return; }
        if (!IMAGE_TYPES[file.type]) { notice.textContent = 'শুধু JPG, PNG বা WebP ছবি দিন।'; notice.hidden = false; fileInput.value = ''; return; }
        if (file.size > MAX_AD_IMAGE) { notice.textContent = 'ছবির আকার সর্বোচ্চ ৫ MB হতে পারে।'; notice.hidden = false; fileInput.value = ''; return; }
        newImg.src = URL.createObjectURL(file);
        newImg.classList.add('show');
      });
      root.querySelector('#scgEditAd').addEventListener('submit', function (event) {
        event.preventDefault();
        saveEditedAd(root, ad);
      });
    });
  }

  async function saveEditedAd(root, ad) {
    var notice = root.querySelector('#ea-notice');
    var title = root.querySelector('#ea-title').value.trim();
    var body = root.querySelector('#ea-body').value.trim();
    var startRaw = root.querySelector('#ea-start').value;
    var endRaw = root.querySelector('#ea-end').value;
    var url = root.querySelector('#ea-burl').value.trim();
    var problems = [];
    if (title.length < 2) problems.push('শিরোনাম লিখুন।');
    if (body.length < 2) problems.push('বার্তা লিখুন।');
    if (!startRaw || !endRaw) problems.push('শুরু ও শেষের সময় দিন।');
    if (url && !/^https:\/\//i.test(url)) problems.push('বাটন URL https:// দিয়ে শুরু হতে হবে।');
    if (startRaw && endRaw && new Date(endRaw) <= new Date(startRaw)) problems.push('শেষের সময় শুরুর পরে হতে হবে।');
    if (problems.length) { notice.textContent = problems.join(' '); notice.hidden = false; return; }

    var button = root.querySelector('#ea-save');
    busy(button, true, 'সংরক্ষণ হচ্ছে…');
    var newPath = null;
    try {
      var file = root.querySelector('#ea-image').files && root.querySelector('#ea-image').files[0];
      var removeBox = root.querySelector('#ea-remove');
      var removeOld = !!(removeBox && removeBox.checked);
      if (file) newPath = await uploadImage(file, 'ads', MAX_AD_IMAGE);
      var imagePath = newPath || (removeOld ? null : ad.image_url || null);
      var r = await getClient().from('ads').update({
        title: title,
        body: body,
        starts_at: new Date(startRaw).toISOString(),
        ends_at: new Date(endRaw).toISOString(),
        button_text: root.querySelector('#ea-btext').value.trim() || null,
        button_url: url || null,
        active: root.querySelector('#ea-active').value === 'true',
        image_url: imagePath
      }).eq('id', ad.id).select('id');
      if (r.error || !r.data || !r.data.length) throw (r.error || new Error('এই কাজের অনুমতি নেই।'));
      if (ad.image_url && imagePath !== ad.image_url) removeImage(ad.image_url);
      closeMyModal();
      toast('বিজ্ঞাপন আপডেট হয়েছে', 'success');
      renderAdsList();
    } catch (error) {
      if (newPath) removeImage(newPath);
      notice.textContent = 'সংরক্ষণ হয়নি: ' + errMsg(error);
      notice.hidden = false;
    } finally {
      busy(button, false);
    }
  }

  function initAdsManager() {
    var tab = $('tab-ads');
    if (!tab) return;
    injectAdImageField();

    // Take over save/preview so the image travels with the ad.
    tab.addEventListener('submit', function (event) {
      if (event.target && event.target.id === 'adForm') saveNewAd(event);
    }, true);
    tab.addEventListener('click', function (event) {
      var t = event.target;
      if (t && t.closest && t.closest('#adPreviewBtn')) previewNewAd(event);
    }, true);

    var list = $('adminAds');
    if (list) {
      list.addEventListener('click', function (event) {
        var t = event.target && event.target.closest ? event.target.closest('button') : null;
        if (!t) return;
        if (t.dataset.xPreview) previewSavedAd(t.dataset.xPreview);
        else if (t.dataset.xEdit) openEditAd(t.dataset.xEdit);
        else if (t.dataset.xToggle) toggleAd(t.dataset.xToggle);
        else if (t.dataset.xDelete) deleteAd(t.dataset.xDelete);
      });
      var timer = null;
      var schedule = function () {
        if (list.querySelector('.scg-adslist')) return;
        clearTimeout(timer);
        timer = setTimeout(function () { if (!list.querySelector('.scg-adslist')) renderAdsList(); }, 80);
      };
      // The original code writes its own table here; replace it with the image-aware one.
      new MutationObserver(schedule).observe(list, { childList: true });
      new MutationObserver(function () {
        if (!tab.classList.contains('hidden')) schedule();
      }).observe(tab, { attributes: true, attributeFilter: ['class'] });
    }
  }

  /* ------------------------------------------------------------------
     4. Admin: Setup & Settings
     ------------------------------------------------------------------ */

  var settingsLoaded = false;

  function injectSettingsUI() {
    var tab = $('tab-settings');
    if (!tab || $('scgOrgForm')) return;

    // The old checklist pointed at a previous database project; real settings replace it.
    Array.prototype.forEach.call(tab.querySelectorAll('.adminsection'), function (sec) {
      var h = sec.querySelector('h2');
      if (h && h.textContent.indexOf('Supabase Dashboard') !== -1) sec.remove();
    });

    var wrap = document.createElement('div');
    wrap.id = 'scgSettingsUI';
    wrap.innerHTML =
      '<div class="adminsection"><h2>প্রতিষ্ঠানের তথ্য</h2>' +
      '<form id="scgOrgForm" class="formgrid" style="margin-top:12px" novalidate>' +
      '<div class="field full"><label for="setOrgName">প্রতিষ্ঠানের নাম</label><input id="setOrgName" maxlength="120" placeholder="S.C.G Blood Organisation"></div>' +
      '<div class="field full"><label for="setLogo">লোগো</label>' +
      '<img id="setLogoPrev" class="scg-logoprev" alt="বর্তমান লোগো" hidden>' +
      '<input id="setLogo" type="file" accept="image/jpeg,image/png,image/webp" style="margin-top:8px">' +
      '<span class="hint">JPG, PNG বা WebP, সর্বোচ্চ ২ MB।</span>' +
      '<label class="scg-check" style="border:0;padding:6px 0 0"><input type="checkbox" id="setLogoRemove"><span>বর্তমান লোগো সরিয়ে দিন</span></label></div>' +
      '<div class="field"><label for="setContactNumber">ফোন নম্বর</label><input id="setContactNumber" type="tel" maxlength="30" placeholder="01XXXXXXXXX"></div>' +
      '<div class="field"><label for="setContactEmail">ইমেইল</label><input id="setContactEmail" type="email" maxlength="120"></div>' +
      '<div class="field full"><label for="setAddress">ঠিকানা</label><input id="setAddress" maxlength="200"></div>' +
      '<div class="field full"><label for="setAbout">প্রতিষ্ঠান সম্পর্কে</label><textarea id="setAbout" rows="3" maxlength="1000"></textarea></div>' +
      '<div class="full"><button class="btn" type="submit" id="setOrgSave">তথ্য সংরক্ষণ করুন</button></div>' +
      '</form></div>' +

      '<div class="adminsection"><h2>ডোনার ও রক্তের অনুরোধ</h2>' +
      '<form id="scgSwitchForm" style="margin-top:6px" novalidate>' +
      '<label class="scg-check"><input type="checkbox" id="setAutoApprove"><span><b>নতুন ডোনার স্বয়ংক্রিয়ভাবে অনুমোদন</b><span class="hint">চালু থাকলে নিবন্ধনের সঙ্গে সঙ্গেই ডোনার তালিকায় নাম আসবে। বন্ধ থাকলে অ্যাডমিনের অনুমোদনের অপেক্ষায় থাকবে।</span></span></label>' +
      '<label class="scg-check"><input type="checkbox" id="setDirectoryPublic"><span><b>পাবলিক ডোনার তালিকা দেখান</b><span class="hint">বন্ধ করলে ওয়েবসাইটে কোনো ডোনারের তথ্য দেখানো হবে না।</span></span></label>' +
      '<label class="scg-check"><input type="checkbox" id="setRequestsPublic"><span><b>রক্তের অনুরোধ গ্রহণ চালু রাখুন</b><span class="hint">বন্ধ করলে ওয়েবসাইট থেকে নতুন রক্তের অনুরোধ জমা দেওয়া যাবে না।</span></span></label>' +
      '<div style="margin-top:12px"><button class="btn" type="submit" id="setSwitchSave">সেটিংস সংরক্ষণ করুন</button></div>' +
      '</form></div>' +

      '<div class="adminsection"><h2>পাসওয়ার্ড পরিবর্তন</h2>' +
      '<p class="small muted">আপনার নিজের অ্যাডমিন অ্যাকাউন্টের পাসওয়ার্ড। বর্তমান পাসওয়ার্ড যাচাই করে নতুনটি সেট হয়।</p>' +
      '<form id="scgPwForm" class="formgrid" style="margin-top:12px" novalidate>' +
      '<div class="field full"><label for="pwCurrent">বর্তমান পাসওয়ার্ড</label><input id="pwCurrent" type="password" autocomplete="current-password"></div>' +
      '<div class="field"><label for="pwNew">নতুন পাসওয়ার্ড</label><input id="pwNew" type="password" minlength="10" autocomplete="new-password"><span class="hint">কমপক্ষে ১০ অক্ষর।</span></div>' +
      '<div class="field"><label for="pwConfirm">নতুন পাসওয়ার্ড আবার লিখুন</label><input id="pwConfirm" type="password" minlength="10" autocomplete="new-password"></div>' +
      '<div class="noticebox full" id="pwNotice" role="alert" hidden></div>' +
      '<div class="full"><button class="btn" type="submit" id="pwSave">পাসওয়ার্ড বদলান</button></div>' +
      '</form></div>';

    var anchor = tab.querySelector('p.muted');
    if (anchor && anchor.nextSibling) tab.insertBefore(wrap, anchor.nextSibling); else tab.appendChild(wrap);

    $('setLogo').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      if (!IMAGE_TYPES[file.type] || file.size > MAX_LOGO_IMAGE) {
        adminNotice('লোগো JPG, PNG বা WebP হতে হবে এবং ২ MB এর কম হতে হবে।');
        this.value = '';
        return;
      }
      adminNotice('');
      var prev = $('setLogoPrev');
      prev.src = URL.createObjectURL(file);
      prev.hidden = false;
    });

    $('scgOrgForm').addEventListener('submit', saveOrgSettings);
    $('scgSwitchForm').addEventListener('submit', saveSwitches);
    $('scgPwForm').addEventListener('submit', changePassword);

    new MutationObserver(function () {
      if (!tab.classList.contains('hidden')) loadSettingsForm();
    }).observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  async function loadSettingsForm() {
    var c = getClient();
    if (!c || !$('scgOrgForm')) return;
    var r = await c.from('site_settings').select('*').eq('id', 1).maybeSingle();
    if (r.error || !r.data) { adminNotice('সেটিংস লোড করা যায়নি: ' + errMsg(r.error)); return; }
    var s = r.data;
    settings = s;
    settingsLoaded = true;
    $('setOrgName').value = s.org_name || '';
    $('setContactNumber').value = s.contact_number || '';
    $('setContactEmail').value = s.contact_email || '';
    $('setAddress').value = s.address || '';
    $('setAbout').value = s.about_org || '';
    $('setAutoApprove').checked = !!s.auto_approve_donors;
    $('setDirectoryPublic').checked = !!s.donor_directory_public;
    $('setRequestsPublic').checked = !!s.requests_public;
    $('setLogo').value = '';
    $('setLogoRemove').checked = false;
    var prev = $('setLogoPrev');
    if (s.logo_url) {
      var urls = await signedUrls([s.logo_url]);
      if (urls[s.logo_url]) { prev.src = urls[s.logo_url]; prev.hidden = false; }
    } else {
      prev.hidden = true;
      prev.removeAttribute('src');
    }
  }

  async function updateSettings(row) {
    var user = await currentUser();
    row.updated_at = new Date().toISOString();
    row.updated_by = user ? user.id : null;
    var r = await getClient().from('site_settings').update(row).eq('id', 1).select('id');
    if (r.error) throw r.error;
    if (!r.data || !r.data.length) throw new Error('এই কাজের অনুমতি নেই। আবার লগইন করে চেষ্টা করুন।');
  }

  async function saveOrgSettings(event) {
    event.preventDefault();
    var email = $('setContactEmail').value.trim();
    var phone = $('setContactNumber').value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { adminNotice('সঠিক ইমেইল ঠিকানা দিন।'); return; }
    if (phone && !/^[0-9+\-\s()]{6,30}$/.test(phone)) { adminNotice('সঠিক ফোন নম্বর দিন।'); return; }
    adminNotice('');
    var button = $('setOrgSave');
    busy(button, true, 'সংরক্ষণ হচ্ছে…');
    var newLogo = null;
    try {
      var old = settings && settings.logo_url ? settings.logo_url : null;
      var file = $('setLogo').files && $('setLogo').files[0];
      var remove = $('setLogoRemove').checked;
      if (file) newLogo = await uploadImage(file, 'logo', MAX_LOGO_IMAGE);
      var logoValue = newLogo || (remove ? null : old);
      await updateSettings({
        org_name: $('setOrgName').value.trim() || null,
        contact_number: phone || null,
        contact_email: email || null,
        address: $('setAddress').value.trim() || null,
        about_org: $('setAbout').value.trim() || null,
        logo_url: logoValue
      });
      if (old && logoValue !== old) removeImage(old);
      toast('প্রতিষ্ঠানের তথ্য সংরক্ষিত হয়েছে', 'success');
      loadSettingsForm();
    } catch (error) {
      if (newLogo) removeImage(newLogo);
      adminNotice('সংরক্ষণ হয়নি: ' + errMsg(error));
    } finally {
      busy(button, false);
    }
  }

  async function saveSwitches(event) {
    event.preventDefault();
    adminNotice('');
    var button = $('setSwitchSave');
    busy(button, true, 'সংরক্ষণ হচ্ছে…');
    try {
      await updateSettings({
        auto_approve_donors: $('setAutoApprove').checked,
        donor_directory_public: $('setDirectoryPublic').checked,
        requests_public: $('setRequestsPublic').checked
      });
      toast('সেটিংস সংরক্ষিত হয়েছে', 'success');
      loadSettingsForm();
    } catch (error) {
      adminNotice('সংরক্ষণ হয়নি: ' + errMsg(error));
    } finally {
      busy(button, false);
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    var notice = $('pwNotice');
    var show = function (msg) { notice.textContent = msg; notice.hidden = !msg; };
    var current = $('pwCurrent').value;
    var next = $('pwNew').value;
    var again = $('pwConfirm').value;
    show('');
    if (!current) { show('বর্তমান পাসওয়ার্ড দিন।'); return; }
    if (next.length < 10) { show('নতুন পাসওয়ার্ড কমপক্ষে ১০ অক্ষরের হতে হবে।'); return; }
    if (next !== again) { show('নতুন পাসওয়ার্ড দুটি মিলছে না।'); return; }
    if (next === current) { show('নতুন পাসওয়ার্ড বর্তমানটির মতো হতে পারবে না।'); return; }
    var user = await currentUser();
    if (!user || !user.email) { show('সেশন পাওয়া যায়নি। আবার লগইন করুন।'); return; }
    var button = $('pwSave');
    busy(button, true, 'যাচাই হচ্ছে…');
    try {
      // A separate, non-persistent client verifies the current password,
      // so the admin's own session in this browser stays untouched.
      var cfg = window.SCG_CONFIG;
      var tmp = window.supabase.createClient(cfg.SUPABASE_URL, String(cfg.SUPABASE_PUBLISHABLE_KEY).trim(), {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
      });
      var signIn = await tmp.auth.signInWithPassword({ email: user.email, password: current });
      if (signIn.error) { show('বর্তমান পাসওয়ার্ড সঠিক নয়।'); return; }
      var upd = await tmp.auth.updateUser({ password: next });
      try { await tmp.auth.signOut({ scope: 'local' }); } catch (e) { /* ignore */ }
      if (upd.error) { show('পাসওয়ার্ড বদলানো যায়নি: ' + errMsg(upd.error)); return; }
      $('scgPwForm').reset();
      toast('পাসওয়ার্ড বদলানো হয়েছে', 'success');
    } catch (error) {
      show('পাসওয়ার্ড বদলানো যায়নি: ' + errMsg(error));
    } finally {
      busy(button, false);
    }
  }

  function initAdmin() {
    initAdsManager();
    injectSettingsUI();
  }

  /* ------------------------------------------------------------------
     5. Start
     ------------------------------------------------------------------ */

  function start() {
    injectStyles();
    if (isAdminRoute()) initAdmin(); else initPublic();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
