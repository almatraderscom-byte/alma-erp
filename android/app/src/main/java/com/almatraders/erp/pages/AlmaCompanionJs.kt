package com.almatraders.erp.pages

/**
 * The ported page-automation dispatcher — one async JS body (action, arg) -> result,
 * identical to iOS AlmaCompanionJS.dispatcher / the Chrome extension page functions.
 * Keep the FINAL-SUBMIT regex in sync with src/agent/lib/browser/final-submit.ts.
 */
object AlmaCompanionJs {
    val DISPATCHER = """
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const findByRef = (ref) => { try { return document.querySelector('[data-alma-ref="' + String(ref).replace(/"/g, '') + '"]'); } catch { return null; } };
    const findBySel = (sel) => { try { return document.querySelector(sel); } catch { return null; } };

    if (action === 'read_text') {
      const t = document.body ? document.body.innerText : '';
      return { ok: true, data: { url: location.href, title: document.title, text: t.slice(0, 12000) } };
    }

    if (action === 'read_dom') {
      const out = [];
      const sel = 'a,button,input,textarea,select,[role=button],[role=link],[role=combobox],[role=menuitem],[role=tab],[role=checkbox],[role=radio],[contenteditable=true]';
      const els = Array.from(document.querySelectorAll(sel)).slice(0, 250);
      let n = 0;
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const ref = 'e' + ++n;
        try { el.setAttribute('data-alma-ref', ref); } catch {}
        out.push({
          ref, tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || (el.tagName === 'SELECT' ? 'select' : null),
          name: el.getAttribute('name') || el.getAttribute('aria-label') || null,
          text: (el.innerText || el.value || el.placeholder || '').trim().slice(0, 80),
          options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 30).map((o) => (o.text || '').trim()) : undefined,
          id: el.id || null,
        });
      }
      return { ok: true, data: { url: location.href, title: document.title, elements: out } };
    }

    if (action === 'scroll') {
      const by = Number(arg.by) || 600;
      window.scrollBy({ top: by, behavior: 'smooth' });
      return { ok: true, scrolledBy: by };
    }

    if (action === 'scroll_to') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('a,button,h1,h2,h3,h4,li,td,th,span,p,label,[role=button],[role=link]'))
          .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 || r.height > 0; })
          .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found to scroll to' };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      return { ok: true, scrolledTo: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60) };
    }

    if (action === 'hover') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('a,button,li,span,div,[role=button],[role=link],[role=menuitem]'))
          .filter(visible)
          .find((e) => (e.innerText || e.getAttribute('aria-label') || '').trim().toLowerCase().includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found to hover' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, view: window };
      for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
        try { el.dispatchEvent(new MouseEvent(type, opts)); } catch {}
      }
      return { ok: true, hovered: (el.innerText || el.getAttribute('aria-label') || el.tagName || '').trim().slice(0, 60) };
    }

    if (action === 'click') {
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).trim().toLowerCase();
        const cand = Array.from(document.querySelectorAll('a,button,[role=button],[role=link],[role=menuitem],[role=tab],input[type=submit],input[type=button],label,summary,[onclick]')).filter(visible);
        const hay = (e) => ((e.innerText || e.value || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).trim().toLowerCase();
        el = cand.find((e) => hay(e) === needle) || cand.find((e) => hay(e).includes(needle)) || null;
      }
      if (!el) return { ok: false, error: 'element not found' };
      // FINAL-SUBMIT BAN — keep in sync with final-submit.ts + the extension.
      const finalSubmitRe = new RegExp([
        '\\b(send|post|publish|pay|buy|purchase|confirm|delete|transfer|submit|checkout)\\b',
        '\\bplace\\s+order\\b', '\\border\\s+now\\b',
        'পাঠান', 'পাঠিয়ে\\s*দিন', 'পোস্ট\\s*করুন', 'পাবলিশ', 'প্রকাশ\\s*করুন', 'কিনুন',
        'অর্ডার\\s*করুন', 'নিশ্চিত\\s*করুন', 'কনফার্ম', 'ডিলিট', 'মুছে\\s*ফেলুন', 'সাবমিট', 'পেমেন্ট\\s*করুন',
      ].join('|'), 'i');
      const elLabel = ((el.innerText || el.value || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim().slice(0, 120);
      if (finalSubmitRe.test(elLabel)) {
        return { ok: false, blocked: true, error: 'final_submit_blocked: "' + elLabel.slice(0, 60) + '" — এই শেষ ক্লিকটা owner নিজে চাপবেন।' };
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(350);
      const rect = el.getBoundingClientRect();
      const mo = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      try {
        el.dispatchEvent(new MouseEvent('mouseover', mo));
        el.dispatchEvent(new MouseEvent('mousedown', mo));
        el.dispatchEvent(new MouseEvent('mouseup', mo));
      } catch {}
      el.click();
      return { ok: true, clicked: (el.innerText || el.value || '').trim().slice(0, 60) };
    }

    if (action === 'type') {
      const setValue = (el, val) => {
        if (el.isContentEditable) {
          el.focus();
          try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, val); } catch {}
          if ((el.innerText || el.textContent || '').trim() === '' && val) {
            el.textContent = val;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
          }
          return;
        }
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, val); else el.value = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: val, inputType: 'insertText' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('input,textarea,[contenteditable=true]')).filter(visible)
          .find((e) => ((e.getAttribute('aria-label') || '') + ' ' + (e.placeholder || '') + ' ' + (e.name || '') + ' ' + (e.getAttribute('title') || '')).toLowerCase().includes(needle)) || null;
      }
      if (!el) {
        const a = document.activeElement;
        if (a && (a.isContentEditable || /^(INPUT|TEXTAREA)$/.test(a.tagName))) el = a;
      }
      if (!el) el = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea,[contenteditable=true]')).filter(visible)[0] || null;
      if (!el) return { ok: false, error: 'field not found' };
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.focus();
      await sleep(250);
      const fullText = arg.value == null ? '' : String(arg.value);
      if (fullText.length > 3 && fullText.length <= 200) {
        const chunks = Math.min(6, Math.max(3, Math.ceil(fullText.length / 18)));
        for (let ci = 1; ci < chunks; ci++) {
          setValue(el, fullText.slice(0, Math.ceil((fullText.length * ci) / chunks)));
          await sleep(90);
        }
      }
      setValue(el, fullText);
      if (arg.submit) {
        await sleep(150);
        const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
        const kd = new KeyboardEvent('keydown', opts);
        el.dispatchEvent(kd);
        el.dispatchEvent(new KeyboardEvent('keypress', opts));
        el.dispatchEvent(new KeyboardEvent('keyup', opts));
        if (!kd.defaultPrevented) {
          const form = el.closest && el.closest('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch { try { form.submit(); } catch {} } }
            else { try { form.submit(); } catch {} }
          }
        }
      }
      return { ok: true, typed: fullText, submitted: Boolean(arg.submit) };
    }

    if (action === 'press') {
      const key = String(arg.key || 'Enter');
      const map = {
        Enter: { keyCode: 13, code: 'Enter', k: 'Enter' }, Tab: { keyCode: 9, code: 'Tab', k: 'Tab' },
        Escape: { keyCode: 27, code: 'Escape', k: 'Escape' }, Esc: { keyCode: 27, code: 'Escape', k: 'Escape' },
        ArrowDown: { keyCode: 40, code: 'ArrowDown', k: 'ArrowDown' }, ArrowUp: { keyCode: 38, code: 'ArrowUp', k: 'ArrowUp' },
        ArrowLeft: { keyCode: 37, code: 'ArrowLeft', k: 'ArrowLeft' }, ArrowRight: { keyCode: 39, code: 'ArrowRight', k: 'ArrowRight' },
        Backspace: { keyCode: 8, code: 'Backspace', k: 'Backspace' }, Delete: { keyCode: 46, code: 'Delete', k: 'Delete' },
        Space: { keyCode: 32, code: 'Space', k: ' ' },
      };
      const info = map[key] || { keyCode: 0, code: key, k: key };
      const opts = { key: info.k, code: info.code, keyCode: info.keyCode, which: info.keyCode, bubbles: true, cancelable: true };
      const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      const kd = new KeyboardEvent('keydown', opts);
      el.dispatchEvent(kd);
      el.dispatchEvent(new KeyboardEvent('keypress', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      if (key === 'Enter' && !kd.defaultPrevented) {
        let form = el.closest && el.closest('form');
        if (!form) {
          const cand = Array.from(document.querySelectorAll('input:not([type=hidden]),textarea')).find((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && e.closest('form');
          });
          form = cand && cand.closest('form');
        }
        if (form) {
          if (typeof form.requestSubmit === 'function') { try { form.requestSubmit(); } catch { try { form.submit(); } catch {} } }
          else { try { form.submit(); } catch {} }
        }
      }
      return { ok: true, pressed: key };
    }

    if (action === 'select_option') {
      const want = String((arg.option != null ? arg.option : arg.value) ?? '');
      let el = (arg.ref && findByRef(arg.ref)) || (arg.selector && findBySel(arg.selector)) || null;
      if (!el && arg.text) {
        const needle = String(arg.text).toLowerCase();
        el = Array.from(document.querySelectorAll('select')).filter(visible)
          .find((s) => ((s.getAttribute('aria-label') || '') + ' ' + (s.name || '') + ' ' + (s.getAttribute('title') || '')).toLowerCase().includes(needle)) || null;
      }
      if (!el) el = Array.from(document.querySelectorAll('select')).filter(visible)[0] || null;
      if (!el) return { ok: false, error: 'select not found' };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'target is not a native <select>' };
      const opts = Array.from(el.options);
      const low = want.trim().toLowerCase();
      const opt = opts.find((o) => (o.text || '').trim().toLowerCase() === low)
        || opts.find((o) => String(o.value).toLowerCase() === low)
        || (low ? opts.find((o) => (o.text || '').trim().toLowerCase().includes(low)) : null);
      if (!opt) return { ok: false, error: 'option not found: ' + want, options: opts.slice(0, 20).map((o) => (o.text || '').trim()) };
      el.focus();
      const desc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value');
      if (desc && desc.set) desc.set.call(el, opt.value); else el.value = opt.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: (opt.text || '').trim(), value: opt.value };
    }

    return { ok: false, error: 'unhandled action: ' + action };
"""
}
