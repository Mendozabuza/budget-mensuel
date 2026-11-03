/*
 * Budget mensuel — application sans serveur.
 * Toutes les données sont stockées dans le localStorage du navigateur, sur l’appareil.
 * Les montants sont stockés en centimes (entiers) pour éviter les erreurs d’arrondi.
 *
 * Modèle :
 *  - incomes / fixed : rentrées et dépenses fixes mensuelles, comptées automatiquement
 *    de leur mois de début (from) à leur mois de fin (until, facultatif).
 *  - overrides[mois][id] : montant spécifique d’une rentrée/dépense fixe pour un mois.
 *  - categories : budgets du quotidien (courses, loisirs…).
 *  - transactions : dépenses du quotidien, rentrées ponctuelles, épargne (versements et retraits).
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'budget-mensuel';
  const SCHEMA_VERSION = 2;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  const PALETTE = ['#2f855a', '#2b6cb0', '#c05621', '#6b46c1', '#b83280', '#2c7a7b', '#b7791f', '#718096', '#4c51bf', '#c53030'];
  const CURRENCIES = ['EUR', 'CHF', 'CAD', 'USD', 'GBP', 'MAD', 'XOF'];
  const SUGGEST = {
    income: ['Salaire', 'APL', 'Prime d’activité', 'Allocations familiales', 'Pension alimentaire', 'Retraite', 'Bourse', 'Autre revenu'],
    fixed: ['Loyer', 'Électricité', 'Gaz', 'Eau', 'Internet', 'Téléphone', 'Assurance habitation', 'Assurance auto', 'Mutuelle', 'Transport en commun', 'Streaming', 'Salle de sport', 'Crédit', 'Impôts', 'Frais bancaires'],
    cat: ['Courses', 'Carburant', 'Restaurants', 'Loisirs', 'Santé', 'Vêtements', 'Enfants', 'Animaux', 'Cadeaux', 'Divers'],
  };
  const DEFAULT_CATS = ['Courses', 'Loisirs', 'Divers'];
  const VIEWS = ['month', 'add', 'savings', 'history', 'settings'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = null;
  const ui = {
    view: 'month',
    month: currentMonth(),
    addType: 'expense',   // expense | income | saving
    saveDir: 'in',        // in (mettre de côté) | out (retirer)
    editingId: null,
    lastCategoryId: null,
    step: 0,
    draft: null,
  };

  /* ---------- Utilitaires ---------- */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function currentMonth() { return todayISO().slice(0, 7); }

  function shiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  }

  function daysInMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function monthLabel(month, opts = { month: 'long', year: 'numeric' }) {
    const [y, m] = month.split('-').map(Number);
    return capitalize(new Date(y, m - 1, 1).toLocaleDateString('fr-FR', opts));
  }

  function monthName(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'long' });
  }

  function dayLabel(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

  function isValidISODate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
  }

  /** "12,50" / "12.5" / "1 200" → centimes ; NaN si invalide. */
  function parseAmount(str) {
    const s = String(str ?? '').replace(/[\s  ]/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function centsToInput(cents) {
    if (!cents) return '';
    return (cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
  }

  function activeCurrency() {
    return (state && state.currency) || (ui.draft && ui.draft.currency) || 'EUR';
  }

  function money(cents, currency = activeCurrency()) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
  }

  function currencySymbol(currency = activeCurrency()) {
    const part = new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency');
    return part ? part.value : currency;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* Animations : désactivées si l'iPhone est réglé sur « Réduire les animations ». */
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';
  const motionOK = () => !!Element.prototype.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  function animate(el, frames, opts) {
    if (el && motionOK()) el.animate(frames, { easing: EASE, ...opts });
  }

  const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  /* ---------- Données ---------- */

  /** Vérifie et normalise des données (stockage local ou import, v1 ou v2). Lève une Error lisible si invalide. */
  function validate(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('le contenu n’est pas un objet JSON.');
    if (!Array.isArray(d.categories) || !Array.isArray(d.transactions)) {
      throw new Error('les champs « categories » et « transactions » sont requis.');
    }
    const isCents = (n) => Number.isInteger(n) && n >= 0;
    const cm = currentMonth();

    const categories = d.categories.map((c, i) => {
      if (!c || typeof c.id !== 'string' || typeof c.name !== 'string' || !isCents(c.budget)) {
        throw new Error(`catégorie n°${i + 1} invalide.`);
      }
      return {
        id: c.id,
        name: c.name.trim().slice(0, 40) || 'Sans nom',
        budget: c.budget,
        color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[i % PALETTE.length],
      };
    });

    const recurring = (list, label) => {
      if (list === undefined) return [];
      if (!Array.isArray(list)) throw new Error(`le champ « ${label} » doit être une liste.`);
      return list.map((r, i) => {
        if (!r || typeof r.id !== 'string' || typeof r.name !== 'string' || !isCents(r.amount)) {
          throw new Error(`${label} n°${i + 1} invalide.`);
        }
        return {
          id: r.id,
          name: r.name.trim().slice(0, 40) || 'Sans nom',
          amount: r.amount,
          from: isMonth(r.from) ? r.from : cm,
          until: isMonth(r.until) ? r.until : null,
        };
      });
    };

    const types = ['expense', 'income', 'saving', 'withdrawal'];
    const transactions = d.transactions.map((t, i) => {
      if (!t || typeof t.id !== 'string' || !types.includes(t.type) ||
          !isValidISODate(t.date) || !Number.isInteger(t.amount) || t.amount <= 0) {
        throw new Error(`opération n°${i + 1} invalide.`);
      }
      return {
        id: t.id,
        type: t.type,
        date: t.date,
        amount: t.amount,
        categoryId: t.type === 'expense' && typeof t.categoryId === 'string' ? t.categoryId : null,
        note: typeof t.note === 'string' ? t.note.slice(0, 120) : '',
      };
    });

    const overrides = {};
    if (d.overrides && typeof d.overrides === 'object') {
      for (const [m, o] of Object.entries(d.overrides)) {
        if (!isMonth(m) || !o || typeof o !== 'object') continue;
        const clean = {};
        for (const [id, v] of Object.entries(o)) if (id !== '__proto__' && isCents(v)) clean[id] = v;
        if (Object.keys(clean).length) overrides[m] = clean;
      }
    }

    return {
      version: SCHEMA_VERSION,
      currency: CURRENCIES.includes(d.currency) ? d.currency : 'EUR',
      savingsTarget: isCents(d.savingsTarget) ? d.savingsTarget : 0,
      savingsStart: isCents(d.savingsStart) ? d.savingsStart : 0,
      incomes: recurring(d.incomes, 'incomes'),
      fixed: recurring(d.fixed, 'fixed'),
      categories,
      overrides,
      transactions,
    };
  }

  function load() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      return validate(JSON.parse(raw));
    } catch {
      // On ne perd jamais des données illisibles : copie de secours avant de repartir de zéro.
      try { localStorage.setItem(`${STORAGE_KEY}:illisible:${Date.now()}`, raw); } catch { /* stockage plein */ }
      alert('Les données enregistrées sont illisibles. Une copie de secours a été conservée ; vous pouvez importer une sauvegarde.');
      return null;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      return true;
    } catch {
      alert('Impossible d’enregistrer sur cet appareil (stockage plein ou navigation privée).');
      return false;
    }
  }

  /* ---------- Calculs ---------- */

  const categoryById = (id) => state.categories.find((c) => c.id === id);
  const isActive = (item, month) => item.from <= month && (!item.until || month <= item.until);

  function recurringFor(list, month) {
    const o = state.overrides[month];
    return list.filter((i) => isActive(i, month)).map((item) => {
      const amount = o && Object.prototype.hasOwnProperty.call(o, item.id) ? o[item.id] : item.amount;
      return { item, amount, changed: amount !== item.amount };
    });
  }

  function summary(month) {
    const incomes = recurringFor(state.incomes, month);
    const fixed = recurringFor(state.fixed, month);
    const tx = state.transactions.filter((t) => t.date.startsWith(month));
    const spentBy = new Map();
    let varSpent = 0, extraIncome = 0, savedIn = 0, savedOut = 0;
    for (const t of tx) {
      if (t.type === 'expense') {
        varSpent += t.amount;
        spentBy.set(t.categoryId, (spentBy.get(t.categoryId) || 0) + t.amount);
      } else if (t.type === 'income') extraIncome += t.amount;
      else if (t.type === 'saving') savedIn += t.amount;
      else savedOut += t.amount;
    }
    const recurringIncome = sum(incomes, (x) => x.amount);
    const fixedTotal = sum(fixed, (x) => x.amount);
    const incomeTotal = recurringIncome + extraIncome;
    const varPlanned = sum(state.categories, (c) => c.budget);
    const savedNet = savedIn - savedOut;
    return {
      tx, incomes, fixed, spentBy, varSpent, extraIncome, savedNet,
      recurringIncome, incomeTotal, fixedTotal, varPlanned,
      remaining: incomeTotal - fixedTotal - varSpent - savedNet,
      margin: recurringIncome - fixedTotal - varPlanned - state.savingsTarget,
    };
  }

  function savingsTotal() {
    return state.savingsStart + sum(state.transactions, (t) => (t.type === 'saving' ? t.amount : t.type === 'withdrawal' ? -t.amount : 0));
  }

  function firstMonth() {
    let first = currentMonth();
    for (const i of [...state.incomes, ...state.fixed]) if (i.from < first) first = i.from;
    for (const t of state.transactions) if (t.date.slice(0, 7) < first) first = t.date.slice(0, 7);
    return first;
  }

  /** Change le montant habituel à partir d’un mois, sans toucher aux mois précédents. */
  function setRecurringFrom(item, month, amount) {
    for (let m = item.from; m < month; m = shiftMonth(m, 1)) {
      const o = (state.overrides[m] ||= {});
      if (!Object.prototype.hasOwnProperty.call(o, item.id)) o[item.id] = item.amount;
    }
    for (const m of Object.keys(state.overrides)) if (m >= month) delete state.overrides[m][item.id];
    item.amount = amount;
    cleanOverrides();
  }

  function removeOverrides(id) {
    for (const m of Object.keys(state.overrides)) delete state.overrides[m][id];
    cleanOverrides();
  }

  function cleanOverrides() {
    for (const m of Object.keys(state.overrides)) if (!Object.keys(state.overrides[m]).length) delete state.overrides[m];
  }

  /** Applique la liste éditée (Réglages) à partir du mois courant : les mois passés restent intacts. */
  function applyRecurring(list, edited, cm) {
    const byId = new Map(edited.map((e) => [e.id, e]));
    const out = [];
    for (const item of list) {
      if (!isActive(item, cm)) { out.push(item); continue; }
      const e = byId.get(item.id);
      if (e) {
        byId.delete(item.id);
        item.name = e.name;
        if (e.amount !== item.amount) setRecurringFrom(item, cm, e.amount);
        out.push(item);
      } else if (item.from < cm) {
        item.until = shiftMonth(cm, -1);
        out.push(item);
      } else {
        removeOverrides(item.id);
      }
    }
    for (const e of byId.values()) out.push({ id: e.id, name: e.name, amount: e.amount, from: cm, until: null });
    return out;
  }

  /* ---------- Éditeur de listes (rentrées, dépenses fixes, budgets) ---------- */

  function rowHTML(item, o) {
    const amount = item.amount ?? item.budget ?? 0;
    return `
      <div class="erow${o.toggle && !item.on ? ' off' : ''}" data-id="${esc(item.id)}"${item.color ? ` data-color="${esc(item.color)}"` : ''}>
        ${o.toggle ? `<input type="checkbox" class="e-on" ${item.on ? 'checked' : ''} aria-label="Utiliser ${esc(item.name)}">` : ''}
        <input class="e-name" value="${esc(item.name)}" placeholder="${esc(o.placeholder || 'Nom')}" maxlength="40" autocomplete="off" aria-label="Nom">
        <span class="money"><input class="e-amount" inputmode="decimal" placeholder="0" value="${centsToInput(amount)}" autocomplete="off" aria-label="Montant par mois"><span class="cur">${esc(currencySymbol(o.currency))}</span></span>
        ${o.toggle ? '' : '<button type="button" class="e-del" aria-label="Retirer cette ligne"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'}
      </div>`;
  }

  function editorHTML(key, items, o) {
    return `<div class="editor" data-editor="${key}">${items.map((i) => rowHTML(i, o)).join('')}</div>
      <div class="suggest" data-suggest="${key}"></div>`;
  }

  function bindEditor(root, key, o, onChange = () => {}) {
    const box = $(`[data-editor="${key}"]`, root);
    const sug = $(`[data-suggest="${key}"]`, root);

    const refresh = () => {
      const present = new Set($$('.e-name', box).map((i) => i.value.trim().toLowerCase()));
      const names = o.toggle ? [] : (o.suggestions || []).filter((s) => !present.has(s.toLowerCase()));
      sug.innerHTML = names.map((s) => `<button type="button" class="chip-add" data-name="${esc(s)}">+ ${esc(s)}</button>`).join('') +
        `<button type="button" class="chip-add other" data-name="">+ ${o.toggle ? 'Autre catégorie' : 'Autre'}</button>`;
    };

    sug.addEventListener('click', (e) => {
      const b = e.target.closest('.chip-add');
      if (!b) return;
      const name = b.dataset.name;
      const color = o.withColor ? PALETTE[$$('.erow', box).length % PALETTE.length] : undefined;
      box.insertAdjacentHTML('beforeend', rowHTML({ id: uid(), name, amount: 0, on: true, color }, o));
      const row = box.lastElementChild;
      (name ? $('.e-amount', row) : $('.e-name', row)).focus();
      refresh();
      onChange();
    });
    box.addEventListener('click', (e) => {
      const del = e.target.closest('.e-del');
      if (!del) return;
      const row = del.closest('.erow');
      if (o.onDelete && !o.onDelete(row)) return;
      row.remove();
      refresh();
      onChange();
    });
    box.addEventListener('change', (e) => {
      if (e.target.classList.contains('e-on')) e.target.closest('.erow').classList.toggle('off', !e.target.checked);
      if (e.target.classList.contains('e-name')) refresh();
      onChange();
    });
    box.addEventListener('input', (e) => {
      // Saisir un montant coche automatiquement la ligne.
      if (o.toggle && e.target.classList.contains('e-amount') && e.target.value.trim()) {
        const row = e.target.closest('.erow');
        $('.e-on', row).checked = true;
        row.classList.remove('off');
      }
      onChange();
    });
    refresh();
  }

  /** Lit un éditeur ; renvoie { items } ou { error }. */
  function readEditor(root, key, { toggle = false, min = 0, what }) {
    const items = [];
    for (const row of $$(`[data-editor="${key}"] .erow`, root)) {
      if (toggle && !$('.e-on', row).checked) continue;
      const name = $('.e-name', row).value.trim();
      const raw = $('.e-amount', row).value.trim();
      if (!name) {
        if (!raw) continue; // ligne vide : ignorée
        return { error: `Une ligne de « ${what} » n’a pas de nom.` };
      }
      const amount = raw === '' ? 0 : parseAmount(raw);
      if (Number.isNaN(amount)) return { error: `Montant invalide pour « ${name} » (exemple : 12,50).` };
      items.push({ id: row.dataset.id, name: name.slice(0, 40), amount, color: row.dataset.color });
    }
    if (items.length < min) return { error: `Gardez au moins une ligne dans « ${what} ».` };
    return { items };
  }

  function sumEditor(root, key, toggle = false) {
    let total = 0;
    for (const row of $$(`[data-editor="${key}"] .erow`, root)) {
      if (toggle && !$('.e-on', row).checked) continue;
      const v = parseAmount($('.e-amount', row).value.trim() || '0');
      if (!Number.isNaN(v)) total += v;
    }
    return total;
  }

  function readMoneyInput(el) {
    const raw = el.value.trim();
    return raw ? parseAmount(raw) : 0;
  }

  function currencyOptions(selected) {
    return CURRENCIES.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c} (${esc(currencySymbol(c))})</option>`).join('');
  }

  /** Récapitulatif du plan mensuel : rentrées − fixes − quotidien − épargne = marge. */
  function planHTML(p) {
    const margin = p.inc - p.fix - p.varp - p.save;
    let msg;
    if (!p.inc) msg = '<p class="msg">Ajoutez vos rentrées pour savoir si votre plan tient.</p>';
    else if (margin > 0) msg = `<p class="msg ok">Votre plan tient : il reste <b>${money(margin)}</b> de marge chaque mois, en plus de vos budgets.</p>`;
    else if (margin === 0) msg = '<p class="msg ok">Votre plan est à l’équilibre : tout votre argent a une place.</p>';
    else msg = `<p class="msg warn">Votre plan dépasse vos rentrées de <b>${money(-margin)}</b> par mois. Réduisez un budget du quotidien ou l’objectif d’épargne.</p>`;
    return `
      <div class="lines">
        <div class="line"><span>Rentrées</span><span class="num">+${money(p.inc)}</span></div>
        <div class="line"><span>Dépenses fixes</span><span class="num">−${money(p.fix)}</span></div>
        <div class="line"><span>Budget du quotidien</span><span class="num">−${money(p.varp)}</span></div>
        <div class="line"><span>Épargne</span><span class="num">−${money(p.save)}</span></div>
        <div class="line total"><span>Marge</span><span class="num${margin < 0 ? ' neg' : ''}">${money(margin)}</span></div>
      </div>
      ${msg}`;
  }

  /* ---------- Premier lancement : parcours guidé ---------- */

  function newDraft() {
    return {
      currency: 'EUR',
      incomes: [{ id: uid(), name: 'Salaire', amount: 0 }],
      fixed: [{ id: uid(), name: 'Loyer', amount: 0 }],
      categories: SUGGEST.cat.map((name, i) => ({ id: uid(), name, budget: 0, color: PALETTE[i % PALETTE.length], on: DEFAULT_CATS.includes(name) })),
      savingsTarget: 0,
      savingsStart: 0,
    };
  }

  const STEP_COUNT = 4;

  /** Change d'étape : la nouvelle page pousse l'ancienne, comme sur iPhone (retour : l'inverse). */
  function goStep(dir) {
    const root = $('#setup');
    let ghost = null;
    if (motionOK()) {
      // Copie figée de l'étape actuelle, avec ce qui a été saisi, pour la faire glisser.
      const copy = root.cloneNode(true);
      copy.removeAttribute('id');
      const from = root.querySelectorAll('input, select');
      copy.querySelectorAll('input, select').forEach((el, i) => { el.value = from[i].value; el.checked = from[i].checked; });
      copy.style.cssText = `position:absolute;left:0;right:0;top:${-window.scrollY}px`;
      ghost = document.createElement('div');
      ghost.className = 'step-ghost';
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.zIndex = dir > 0 ? 1 : 3;
      ghost.appendChild(copy);
      document.body.appendChild(ghost);
    }
    ui.step += dir;
    renderSetup();
    window.scrollTo(0, 0);
    if (!ghost) return;
    const opts = { duration: 350, easing: EASE };
    root.classList.add('pushing');
    root.animate([{ transform: `translateX(${dir > 0 ? 100 : -30}%)` }, { transform: 'none' }], opts);
    const end = () => { ghost.remove(); root.classList.remove('pushing'); };
    ghost.animate([{ transform: 'none' }, { transform: `translateX(${dir > 0 ? -30 : 100}%)` }], opts).onfinish = end;
    setTimeout(end, 500); // au cas où l'animation serait suspendue (app mise en arrière-plan)
  }

  function renderSetup() {
    const d = ui.draft;
    const s = ui.step;
    const o = { currency: d.currency };
    let title, intro, body = '', next = 'Continuer';

    if (s === 0) {
      title = 'Bienvenue';
      intro = 'En 4 étapes, on prépare votre budget du mois. Vous pourrez tout modifier ensuite.';
      body = `
        <ol class="howto">
          <li><b>Ce qui rentre</b> : salaire, aides…</li>
          <li><b>Ce qui sort chaque mois</b> : loyer, factures, abonnements…</li>
          <li><b>Le quotidien</b> : courses, loisirs…</li>
          <li><b>Ce que vous mettez de côté</b></li>
        </ol>
        <label class="field"><span>Devise</span><select id="d-currency">${currencyOptions(d.currency)}</select></label>`;
      next = 'Commencer';
    } else if (s === 1) {
      title = 'Ce qui rentre chaque mois';
      intro = 'Salaire, aides (APL, prime d’activité…), pension… Indiquez le montant habituel. Si une aide varie, mettez une estimation : vous pourrez l’ajuster chaque mois.';
      body = `${editorHTML('income', d.incomes, { ...o, placeholder: 'Nom de la rentrée' })}
        <p class="live" id="live"></p>`;
    } else if (s === 2) {
      title = 'Ce qui sort chaque mois';
      intro = 'Les dépenses qui tombent tous les mois quoi qu’il arrive : loyer, factures, abonnements, assurances, crédit… Les courses, on les voit à l’étape suivante.';
      body = `${editorHTML('fixed', d.fixed, { ...o, placeholder: 'Nom de la dépense' })}
        <p class="live" id="live"></p>`;
    } else if (s === 3) {
      title = 'Votre budget du quotidien';
      intro = 'Ce que vous dépensez différemment chaque mois. Cochez ce qui vous concerne et fixez un montant à ne pas dépasser.';
      body = `${editorHTML('cat', d.categories, { ...o, toggle: true })}
        <p class="live" id="live"></p>`;
    } else {
      title = 'Votre épargne';
      intro = 'Mettre de côté un peu chaque mois, même une petite somme, aide à faire face aux imprévus.';
      body = `
        <label class="field"><span>Combien mettre de côté chaque mois ?</span>
          <span class="money"><input id="d-target" inputmode="decimal" placeholder="0" value="${centsToInput(d.savingsTarget)}" autocomplete="off"><span class="cur">${esc(currencySymbol())}</span></span></label>
        <label class="field"><span>Épargne déjà disponible (facultatif)</span>
          <span class="money"><input id="d-start" inputmode="decimal" placeholder="0" value="${centsToInput(d.savingsStart)}" autocomplete="off"><span class="cur">${esc(currencySymbol())}</span></span></label>
        <h2 class="sec">Votre plan chaque mois</h2>
        <div id="live"></div>`;
      next = 'Terminer';
    }

    $('#setup').innerHTML = `
      <div class="setup-inner">
        ${s > 0 ? `
          <div class="steps" aria-hidden="true">${Array.from({ length: STEP_COUNT }, (_, i) => `<span class="${i < s ? 'on' : ''}"></span>`).join('')}</div>
          <p class="step-label">Étape ${s} sur ${STEP_COUNT}</p>` : ''}
        <h1>${title}</h1>
        <p class="intro">${intro}</p>
        ${body}
        <p class="error" id="setup-error" role="alert"></p>
        <div class="nav-btns">
          ${s > 0 ? '<button type="button" class="btn ghost" id="setup-back">Retour</button>' : ''}
          <button type="button" class="btn primary" id="setup-next">${next}</button>
        </div>
        ${s === 0 ? `
          <button type="button" class="link" id="setup-import">J’ai déjà une sauvegarde : importer un fichier</button>
          <p class="note center">Vos données restent sur ce téléphone. Rien n’est envoyé sur Internet.</p>` : ''}
      </div>`;

    const root = $('#setup');
    const live = () => updateSetupLive(root);
    if (s === 1) bindEditor(root, 'income', { ...o, suggestions: SUGGEST.income, placeholder: 'Nom de la rentrée' }, live);
    if (s === 2) bindEditor(root, 'fixed', { ...o, suggestions: SUGGEST.fixed, placeholder: 'Nom de la dépense' }, live);
    if (s === 3) bindEditor(root, 'cat', { ...o, toggle: true, withColor: true, placeholder: 'Nom de la catégorie' }, live);
    if (s === 4) root.addEventListener('input', live);
    if (s > 0) live();

    $('#setup-next').addEventListener('click', () => {
      const err = readStep();
      if (err) { $('#setup-error').textContent = err; return; }
      if (ui.step < STEP_COUNT) {
        goStep(1);
      } else {
        finishSetup();
      }
    });
    if (s > 0) {
      $('#setup-back').addEventListener('click', () => {
        readStep(); // garde ce qui est valide, sans bloquer le retour
        goStep(-1);
      });
    }
    if (s === 0) {
      $('#setup-import').addEventListener('click', () => $('#import-file').click());
    }
  }

  function updateSetupLive(root) {
    const d = ui.draft;
    const el = $('#live', root);
    const inc = ui.step === 1 ? sumEditor(root, 'income') : sum(d.incomes, (i) => i.amount);
    const fix = ui.step === 2 ? sumEditor(root, 'fixed') : sum(d.fixed, (i) => i.amount);
    if (ui.step === 1) {
      el.innerHTML = `Total des rentrées : <b>${money(inc)}</b> par mois`;
    } else if (ui.step === 2) {
      el.innerHTML = `Total : <b>${money(fix)}</b> par mois.<br>Après les dépenses fixes, il vous reste <b class="${inc - fix < 0 ? 'neg' : ''}">${money(inc - fix)}</b>.`;
    } else if (ui.step === 3) {
      const varp = sumEditor(root, 'cat', true);
      const left = inc - fix - varp;
      el.innerHTML = `Budget du quotidien : <b>${money(varp)}</b> par mois.<br>${left >= 0
        ? `Il reste <b>${money(left)}</b> pour l’épargne et les imprévus.`
        : `Attention : <b class="neg">${money(-left)}</b> de plus que ce qui reste après les dépenses fixes.`}`;
    } else if (ui.step === 4) {
      const target = parseAmount($('#d-target', root).value.trim() || '0');
      const varp = sum(d.categories.filter((c) => c.on), (c) => c.budget);
      el.innerHTML = planHTML({ inc, fix, varp, save: Number.isNaN(target) ? 0 : target });
    }
  }

  /** Lit l’étape affichée dans le brouillon. Renvoie un message d’erreur ou ''. */
  function readStep() {
    const d = ui.draft;
    const root = $('#setup');
    if (ui.step === 0) {
      d.currency = $('#d-currency', root).value;
    } else if (ui.step === 1 || ui.step === 2) {
      const key = ui.step === 1 ? 'income' : 'fixed';
      const r = readEditor(root, key, { what: ui.step === 1 ? 'Rentrées' : 'Dépenses fixes' });
      if (r.error) return r.error;
      d[ui.step === 1 ? 'incomes' : 'fixed'] = r.items.map(({ id, name, amount }) => ({ id, name, amount }));
    } else if (ui.step === 3) {
      const r = readEditor(root, 'cat', { toggle: true, min: 1, what: 'Budget du quotidien' });
      if (r.error) return r.error;
      d.categories = $$('[data-editor="cat"] .erow', root)
        .map((row, i) => ({
          id: row.dataset.id,
          name: $('.e-name', row).value.trim().slice(0, 40),
          budget: parseAmount($('.e-amount', row).value.trim() || '0') || 0,
          color: row.dataset.color || PALETTE[i % PALETTE.length],
          on: $('.e-on', row).checked,
        }))
        .filter((c) => c.name);
    } else {
      const target = readMoneyInput($('#d-target', root));
      const start = readMoneyInput($('#d-start', root));
      if (Number.isNaN(target)) return 'Montant d’épargne mensuelle invalide (exemple : 50).';
      if (Number.isNaN(start)) return 'Montant d’épargne disponible invalide.';
      d.savingsTarget = target;
      d.savingsStart = start;
    }
    return '';
  }

  function finishSetup() {
    const d = ui.draft;
    const cm = currentMonth();
    state = {
      version: SCHEMA_VERSION,
      currency: d.currency,
      savingsTarget: d.savingsTarget,
      savingsStart: d.savingsStart,
      incomes: d.incomes.map((i) => ({ ...i, from: cm, until: null })),
      fixed: d.fixed.map((i) => ({ ...i, from: cm, until: null })),
      categories: d.categories.filter((c) => c.on).map(({ id, name, budget, color }) => ({ id, name, budget, color })),
      overrides: {},
      transactions: [],
    };
    if (!save()) return;
    ui.draft = null;
    requestPersistence();
    start();
    toast('Votre budget est prêt');
  }

  /* ---------- Navigation ---------- */

  const TITLES = { add: 'Nouvelle opération', savings: 'Épargne', settings: 'Réglages' };

  function show(view) {
    ui.view = view;
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
    render();
    window.scrollTo(0, 0);
    animate($(`#view-${view}`), [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 260 });
  }

  /** Mois précédent / suivant : le contenu glisse dans le sens du mois. */
  function goMonth(dir) {
    ui.month = shiftMonth(ui.month, dir);
    render();
    const frames = (d) => [{ opacity: 0, transform: `translateX(${d}px)` }, { opacity: 1, transform: 'none' }];
    animate($(`#view-${ui.view}`), frames(dir * 60), { duration: 280 });
    animate($('#title'), frames(dir * 16), { duration: 240 });
  }

  function render() {
    const hasNav = ui.view === 'month' || ui.view === 'history';
    $('.topbar').classList.toggle('no-nav', !hasNav);
    $('#title').textContent = hasNav ? monthLabel(ui.month) : (ui.editingId ? 'Modifier' : TITLES[ui.view]);
    ({ month: renderMonth, add: renderAdd, savings: renderSavings, history: renderHistory, settings: renderSettings })[ui.view]();
  }

  /* ---------- Graphiques (SVG/HTML dessinés ici, sans bibliothèque : fonctionnent hors ligne) ---------- */

  function roundMoney(cents) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: activeCurrency(), maximumFractionDigits: 0 }).format(cents / 100);
  }

  function monthShort(month) {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('fr-FR', { month: 'short' }).replace('.', '');
  }

  const fx = (n) => n.toFixed(1);

  /** 1. Où va mon argent : une barre empilée fixes / quotidien / épargne / reste. */
  function stackHTML(s) {
    const save = Math.max(s.savedNet, 0);
    const out = s.fixedTotal + s.varSpent + save;
    const base = Math.max(s.incomeTotal, out);
    if (!base) return '';
    const parts = [
      ['fixed', 'Fixes', s.fixedTotal],
      ['var', 'Quotidien', s.varSpent],
      ['save', 'Épargne', save],
      ['left', 'Reste', Math.max(s.incomeTotal - out, 0)],
    ].filter((p) => p[2] > 0);
    const pct = (v) => Math.round((v / base) * 100);
    const over = s.incomeTotal > 0 && out > s.incomeTotal;
    return `
      <div class="chart">
        <div class="stack-wrap">
          <div class="stack" role="img" aria-label="${esc(parts.map((p) => `${p[1]} ${pct(p[2])} %`).join(', '))}">
            ${parts.map((p) => `<span class="seg-${p[0]}" style="width:${(p[2] / base * 100).toFixed(2)}%"></span>`).join('')}
          </div>
          ${over ? `<i class="stack-limit" style="left:${fx(s.incomeTotal / base * 100)}%"></i>` : ''}
        </div>
        <div class="legend">${parts.map((p) => `<span><i class="seg-${p[0]}"></i>${p[1]} ${pct(p[2])} %</span>`).join('')}</div>
        ${over ? '<p class="note">Le trait rouge marque vos rentrées : ce qui dépasse à droite est dépensé en trop.</p>' : ''}
      </div>`;
  }

  /** 2. Suis-je dans les clous : dépenses du quotidien cumulées jour après jour, face au rythme prévu. */
  function paceHTML(month) {
    const planned = sum(state.categories, (c) => c.budget);
    const cm = currentMonth();
    if (!planned || month > cm) return '';
    const dim = daysInMonth(month);
    const lastDay = month === cm ? new Date().getDate() : dim;
    const perDay = new Array(dim + 1).fill(0);
    for (const t of state.transactions) {
      if (t.type === 'expense' && t.date.startsWith(month)) perDay[Number(t.date.slice(8, 10))] += t.amount;
    }
    const pts = [];
    let acc = 0;
    for (let d = 0; d <= lastDay; d++) { acc += perDay[d]; pts.push([d, acc]); }

    const W = 300, H = 140, L = 4, R = 4, T = 16, B = 20;
    const max = Math.max(planned, acc) * 1.08;
    const x = (d) => L + (d / dim) * (W - L - R);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const over = acc > planned;
    const expected = Math.round(planned * lastDay / dim);
    const labelRight = lastDay < dim * 0.65;

    return `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dépenses du quotidien cumulées : ${esc(money(acc))} au jour ${lastDay}, pour un budget de ${esc(money(planned))}">
        <line class="ch-axis" x1="${L}" y1="${fx(y(0))}" x2="${W - R}" y2="${fx(y(0))}"/>
        <line class="ch-budget" x1="${L}" y1="${fx(y(planned))}" x2="${W - R}" y2="${fx(y(planned))}"/>
        <text x="${W - R}" y="${fx(y(planned) - 5)}" text-anchor="end">budget ${esc(roundMoney(planned))}</text>
        <line class="ch-ideal" x1="${fx(x(0))}" y1="${fx(y(0))}" x2="${fx(x(dim))}" y2="${fx(y(planned))}"/>
        <polyline class="ch-line${over ? ' over' : ''}" points="${pts.map(([d, v]) => `${fx(x(d))},${fx(y(v))}`).join(' ')}"/>
        <circle class="ch-dot${over ? ' over' : ''}" cx="${fx(x(lastDay))}" cy="${fx(y(acc))}" r="4"/>
        <text class="ch-value" x="${fx(x(lastDay) + (labelRight ? 8 : 0))}" y="${fx(y(acc) + (labelRight ? 4 : -10))}" text-anchor="${labelRight ? 'start' : 'end'}">${esc(roundMoney(acc))}</text>
        <text x="${L}" y="${H - 4}">1</text>
        <text x="${W - R}" y="${H - 4}" text-anchor="end">${dim}</text>
      </svg>
      <div class="legend"><span><i class="k-ink${over ? ' over' : ''}"></i>Dépensé</span><span><i class="k-dash"></i>Rythme prévu</span></div>
      <p class="note">${month === cm
        ? `Au ${lastDay} ${monthName(month)}, vous avez dépensé ${money(acc)} au quotidien ; le rythme prévu était d’environ ${money(expected)}.`
        : `Total du mois : ${money(acc)} pour un budget de ${money(planned)}.`}</p>`;
  }

  /** 5. Où part le quotidien : catégories triées de la plus grosse à la plus petite. */
  function shareHTML(s) {
    const rows = [...s.spentBy]
      .map(([id, amount]) => ({ name: (categoryById(id) || {}).name || 'Sans catégorie', amount }))
      .filter((r) => r.amount > 0)
      .sort((a, b) => b.amount - a.amount);
    if (rows.length < 2) return '';
    const max = rows[0].amount;
    return `
      <div class="share" role="img" aria-label="Répartition du quotidien : ${esc(rows.map((r) => `${r.name} ${Math.round(r.amount / s.varSpent * 100)} %`).join(', '))}">
        ${rows.map((r, i) => `
          <div class="share-row">
            <span class="share-name">${esc(r.name)}</span>
            <span class="share-bar"><i class="${i ? '' : 'top'}" style="width:${fx(r.amount / max * 100)}%"></i></span>
            <span class="num share-pct">${Math.round(r.amount / s.varSpent * 100)} %</span>
          </div>`).join('')}
      </div>`;
  }

  /** 3. Les 6 derniers mois : rentrées face aux dépenses (fixes + quotidien). */
  function monthsHTML() {
    const cm = currentMonth();
    const first = firstMonth();
    const months = [];
    for (let m = cm, n = 0; n < 6 && m >= first; m = shiftMonth(m, -1), n++) months.unshift(m);
    if (months.length < 2) return '<p class="note">Ce graphique se remplira au fil des mois : revenez le mois prochain.</p>';

    const data = months.map((m) => {
      const s = summary(m);
      return { m, inc: s.incomeTotal, out: s.fixedTotal + s.varSpent };
    });
    const max = Math.max(1, ...data.flatMap((d) => [d.inc, d.out])) * 1.1;
    const W = 300, H = 140, T = 6, B = 20;
    const slot = W / months.length;
    const bw = Math.min(18, slot / 3);
    const y = (v) => T + (1 - v / max) * (H - T - B);
    const positive = data.filter((d) => d.inc >= d.out).length;

    const bars = data.map((d, i) => {
      const cx = slot * i + slot / 2;
      return `
        <rect class="ch-inc" style="animation-delay:${i * 50}ms" x="${fx(cx - bw - 1)}" y="${fx(y(d.inc))}" width="${fx(bw)}" height="${fx(y(0) - y(d.inc))}" rx="3"/>
        <rect class="ch-out${d.out > d.inc ? ' over' : ''}" style="animation-delay:${i * 50 + 25}ms" x="${fx(cx + 1)}" y="${fx(y(d.out))}" width="${fx(bw)}" height="${fx(y(0) - y(d.out))}" rx="3"/>
        <text x="${fx(cx)}" y="${H - 4}" text-anchor="middle"${d.m === cm ? ' class="ch-strong"' : ''}>${esc(monthShort(d.m))}</text>`;
    }).join('');

    return `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Rentrées et dépenses des ${months.length} derniers mois">
        <line class="ch-axis" x1="0" y1="${fx(y(0))}" x2="${W}" y2="${fx(y(0))}"/>
        ${bars}
      </svg>
      <div class="legend"><span><i class="k-ink"></i>Rentrées</span><span><i class="k-mute"></i>Dépenses</span><span><i class="k-neg"></i>Dépenses &gt; rentrées</span></div>
      <p class="note">${positive} mois sur ${months.length} où vos rentrées ont couvert vos dépenses.</p>`;
  }

  /** 4. Épargne qui grandit : total épargné à la fin de chaque mois. */
  function savingsChartHTML() {
    const cm = currentMonth();
    const first = firstMonth();
    const months = [];
    for (let m = cm, n = 0; n < 12 && m >= first; m = shiftMonth(m, -1), n++) months.unshift(m);
    if (months.length < 2) return '<p class="note">La courbe apparaîtra dès le mois prochain.</p>';

    const delta = (t) => (t.type === 'saving' ? t.amount : t.type === 'withdrawal' ? -t.amount : 0);
    const values = months.map((m) => state.savingsStart + sum(state.transactions.filter((t) => t.date.slice(0, 7) <= m), delta));
    const W = 300, H = 130, L = 4, R = 4, T = 18, B = 20;
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values) * 1.1;
    const x = (i) => L + (i / (months.length - 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const line = values.map((v, i) => `${fx(x(i))},${fx(y(v))}`).join(' ');
    const last = values.length - 1;

    return `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Épargne totale de ${esc(money(values[0]))} à ${esc(money(values[last]))} sur ${months.length} mois">
        <line class="ch-axis" x1="${L}" y1="${fx(y(min))}" x2="${W - R}" y2="${fx(y(min))}"/>
        <polygon class="ch-save-area" points="${fx(x(0))},${fx(y(min))} ${line} ${fx(x(last))},${fx(y(min))}"/>
        <polyline class="ch-save-line" points="${line}"/>
        <circle class="ch-save-dot" cx="${fx(x(last))}" cy="${fx(y(values[last]))}" r="4"/>
        <text class="ch-value" x="${fx(x(last))}" y="${fx(y(values[last]) - 9)}" text-anchor="end">${esc(roundMoney(values[last]))}</text>
        <text x="${L}" y="${H - 4}">${esc(monthShort(months[0]))}</text>
        <text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(monthShort(months[last]))}</text>
      </svg>`;
  }

  /* ---------- Vue du mois ---------- */

  function bar(value, max, cls = '') {
    const pct = max > 0 ? Math.min(value / max, 1) * 100 : (value > 0 ? 100 : 0);
    return `<div class="bar ${cls}"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  }

  function tips(s, month) {
    const out = [];
    const cm = currentMonth();
    const isCur = month === cm;
    if (!state.incomes.some((i) => isActive(i, month)) && month >= cm) {
      out.push({ kind: '', text: 'Ajoutez vos rentrées d’argent (salaire, aides…) pour voir ce qu’il vous reste.', action: 'settings', label: 'Ajouter' });
    } else if (s.margin < 0) {
      out.push({ kind: 'warn', text: `Vos dépenses prévues (fixes, quotidien et épargne) dépassent vos rentrées de ${money(-s.margin)} par mois.`, action: 'settings', label: 'Ajuster' });
    }
    const over = state.categories.filter((c) => (s.spentBy.get(c.id) || 0) > c.budget);
    if (over.length === 1) {
      const c = over[0];
      out.push({ kind: 'warn', text: `${c.name} : budget dépassé de ${money((s.spentBy.get(c.id) || 0) - c.budget)}.` });
    } else if (over.length > 1) {
      out.push({ kind: 'warn', text: `${over.length} budgets dépassés : ${over.map((c) => c.name).join(', ')}.` });
    }
    if (isCur && s.varPlanned > 0 && !over.length) {
      const day = new Date().getDate();
      const expected = Math.round(s.varPlanned * day / daysInMonth(month));
      // Pas avant le 7 : en début de mois, un seul passage en caisse fausse le rythme.
      if (day >= 7 && s.varSpent > expected * 1.1 && day < daysInMonth(month)) {
        out.push({ kind: '', text: `Vous dépensez un peu plus vite que prévu : ${money(s.varSpent)} dépensés au quotidien, environ ${money(expected)} prévus à cette date.` });
      }
    }
    if (isCur && state.savingsTarget > 0) {
      const daysLeft = daysInMonth(month) - new Date().getDate();
      if (s.savedNet >= state.savingsTarget) {
        out.push({ kind: 'ok', text: 'Objectif d’épargne du mois atteint. Bravo.' });
      } else if (daysLeft <= 7) {
        out.push({ kind: '', text: `Pensez à mettre de côté ${money(state.savingsTarget - Math.max(s.savedNet, 0))} pour atteindre votre objectif du mois.`, action: 'save', label: 'Épargner' });
      }
    }
    return out.slice(0, 3);
  }

  function renderMonth() {
    const m = ui.month;
    const cm = currentMonth();
    const s = summary(m);
    const isCur = m === cm;

    let sub;
    if (isCur) {
      const daysLeft = daysInMonth(m) - new Date().getDate() + 1;
      sub = s.remaining > 0
        ? `soit environ <b>${money(Math.floor(s.remaining / daysLeft))}</b> par jour pendant ${plural(daysLeft, 'jour')}`
        : 'Vos dépenses dépassent vos rentrées ce mois-ci.';
    } else {
      sub = m < cm ? 'en fin de mois' : 'prévu, avant les dépenses du quotidien';
    }

    const recLines = (list, kind) => list.length
      ? list.map(({ item, amount, changed }) => `
          <button type="button" class="line rec" data-kind="${kind}" data-id="${esc(item.id)}">
            <span>${esc(item.name)}${changed ? ' <small>(ajusté)</small>' : ''}</span>
            <span class="num">${money(amount)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>
          </button>`).join('')
      : `<p class="note">Aucune ligne. <button type="button" class="link inline" data-go="settings">Ajouter dans Réglages</button></p>`;

    const catLines = state.categories.map((c) => {
      const spent = s.spentBy.get(c.id) || 0;
      const diff = c.budget - spent;
      return `
        <div class="cat">
          <div class="cat-top">
            <span class="name"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>
            <span class="num">${money(spent)} <span class="muted">/ ${money(c.budget)}</span></span>
          </div>
          ${bar(spent, c.budget, diff < 0 ? 'over' : '')}
          <div class="cat-left${diff < 0 ? ' neg' : ''}">${diff >= 0 ? `Reste ${money(diff)}` : `Dépassé de ${money(-diff)}`}</div>
        </div>`;
    });
    let orphan = 0;
    for (const [id, amount] of s.spentBy) if (!categoryById(id)) orphan += amount;
    if (orphan) {
      catLines.push(`<div class="cat"><div class="cat-top"><span class="name"><span class="dot"></span>Sans catégorie</span><span class="num">${money(orphan)}</span></div></div>`);
    }

    const tipList = tips(s, m);
    const pace = paceHTML(m);

    $('#view-month').innerHTML = `
      <section class="hero">
        <p class="eyebrow">${s.remaining >= 0 ? 'Il vous reste' : 'Dépassement'}</p>
        <p class="big num${s.remaining < 0 ? ' neg' : ''}">${money(Math.abs(s.remaining))}</p>
        <p class="sub">${sub}</p>
      </section>

      ${stackHTML(s)}

      ${tipList.map((t) => `
        <div class="tip ${t.kind}">
          <p>${esc(t.text)}</p>
          ${t.action ? `<button type="button" class="link inline" data-go="${t.action}">${t.label}</button>` : ''}
        </div>`).join('')}

      <section class="block">
        <h2 class="sec">Ce mois-ci</h2>
        <details class="flow">
          <summary><span>Rentrées</span><span class="num pos">+${money(s.incomeTotal)}</span></summary>
          <div class="sub-lines">
            ${recLines(s.incomes, 'income')}
            ${s.extraIncome ? `<div class="line"><span>Rentrées ponctuelles</span><span class="num">${money(s.extraIncome)}</span></div>` : ''}
            ${s.incomes.length ? '<p class="note">Touchez une ligne pour changer son montant ce mois-ci.</p>' : ''}
          </div>
        </details>
        <details class="flow">
          <summary><span>Dépenses fixes</span><span class="num">−${money(s.fixedTotal)}</span></summary>
          <div class="sub-lines">
            ${recLines(s.fixed, 'fixed')}
            ${s.fixed.length ? '<p class="note">Touchez une ligne pour changer son montant ce mois-ci.</p>' : ''}
          </div>
        </details>
        <div class="line flowrow"><span>Dépenses du quotidien</span><span class="num">−${money(s.varSpent)}</span></div>
        <div class="line flowrow"><span>Épargne</span><span class="num">${s.savedNet > 0 ? '−' : s.savedNet < 0 ? '+' : ''}${money(Math.abs(s.savedNet))}</span></div>
        <div class="line total"><span>Il reste</span><span class="num${s.remaining < 0 ? ' neg' : ''}">${money(s.remaining)}</span></div>
      </section>

      ${pace ? `
        <section class="block">
          <h2 class="sec">Suis-je dans les clous ?</h2>
          ${pace}
        </section>` : ''}

      <section class="block">
        <h2 class="sec">Budget du quotidien <span class="muted">${money(s.varSpent)} / ${money(s.varPlanned)}</span></h2>
        ${shareHTML(s)}
        ${catLines.join('')}
      </section>

      <section class="block">
        <h2 class="sec">Vos derniers mois</h2>
        ${monthsHTML()}
      </section>

      ${s.tx.length ? '' : `<p class="empty">Aucune dépense notée ce mois-ci.<br><button type="button" class="link inline" data-go="add">Noter une dépense</button></p>`}
    `;

    const view = $('#view-month');
    $$('.rec', view).forEach((b) => b.addEventListener('click', () => openRecurring(b.dataset.kind, b.dataset.id)));
    bindGo(view);
  }

  function bindGo(root) {
    $$('[data-go]', root).forEach((b) => b.addEventListener('click', () => {
      ui.editingId = null;
      if (b.dataset.go === 'save') { ui.addType = 'saving'; ui.saveDir = 'in'; show('add'); return; }
      if (b.dataset.go === 'withdraw') { ui.addType = 'saving'; ui.saveDir = 'out'; show('add'); return; }
      if (b.dataset.go === 'add') ui.addType = 'expense';
      show(b.dataset.go);
    }));
  }

  /* Fenêtre : ajuster une rentrée / dépense fixe pour un mois */

  let dlgTarget = null;

  function openRecurring(kind, id) {
    const list = kind === 'income' ? state.incomes : state.fixed;
    const item = list.find((i) => i.id === id);
    if (!item) return;
    const m = ui.month;
    const current = recurringFor([item], m)[0].amount;
    const dlg = $('#dlg');
    if (typeof dlg.showModal !== 'function') {
      // Navigateur ancien : saisie simple pour ce mois.
      const v = prompt(`${item.name} — montant pour ${monthName(m)}`, centsToInput(current));
      if (v === null) return;
      const amount = parseAmount(v.trim() || '0');
      if (Number.isNaN(amount)) { alert('Montant invalide.'); return; }
      setOverride(item, m, amount);
      return;
    }
    dlgTarget = { item, month: m };
    $('#dlg-title').textContent = item.name;
    $('#dlg-text').textContent = `Montant habituel : ${money(item.amount)}. Mettez 0 si rien n’est prévu ce mois-ci.`;
    $('#dlg-amount').value = centsToInput(current);
    $('#dlg .cur').textContent = currencySymbol();
    $('#dlg-error').textContent = '';
    $('#dlg-month').textContent = `Pour ${monthName(m)} seulement`;
    $('#dlg-always').textContent = `Pour tous les mois dès ${monthName(m)}`;
    dlg.showModal();
  }

  function setOverride(item, month, amount) {
    const o = (state.overrides[month] ||= {});
    if (amount === item.amount) delete o[item.id];
    else o[item.id] = amount;
    cleanOverrides();
    save();
    toast(`Montant ajusté pour ${monthName(month)}`);
    render();
  }

  /** Referme la fenêtre en la faisant redescendre. */
  function closeDialog() {
    const dlg = $('#dlg');
    if (!dlg.open || dlg.classList.contains('closing')) return;
    if (!motionOK()) { dlg.close(); return; }
    dlg.classList.add('closing');
    let done = false;
    const end = () => { if (done) return; done = true; dlg.classList.remove('closing'); dlg.close(); };
    dlg.addEventListener('animationend', end, { once: true });
    setTimeout(end, 400);
  }

  /** Garde la fenêtre au-dessus du clavier de l'iPhone. */
  function followKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const dlg = $('#dlg');
    const place = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      dlg.style.setProperty('--kb', `${hidden}px`);
    };
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
  }

  function bindDialog() {
    const dlg = $('#dlg');
    followKeyboard();
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(); }); // touche Échap
    dlg.addEventListener('click', (e) => { // toucher en dehors de la fenêtre
      const r = dlg.getBoundingClientRect();
      if (e.target === dlg && (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right)) closeDialog();
    });
    $('#dlg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const choice = e.submitter ? e.submitter.value : 'month';
      if (choice === 'cancel' || !dlgTarget) { closeDialog(); return; }
      const amount = readMoneyInput($('#dlg-amount'));
      if (Number.isNaN(amount)) { $('#dlg-error').textContent = 'Montant invalide (exemple : 12,50).'; return; }
      const { item, month } = dlgTarget;
      closeDialog();
      dlgTarget = null;
      if (choice === 'always') {
        setRecurringFrom(item, month, amount);
        save();
        toast(`Nouveau montant à partir de ${monthName(month)}`);
        render();
      } else {
        setOverride(item, month, amount);
      }
    });
  }

  /* ---------- Ajout / modification ---------- */

  const ADD_HINTS = {
    expense: 'Courses, sorties, achats… Les dépenses fixes (loyer, abonnements) sont déjà comptées chaque mois.',
    income: 'Une rentrée exceptionnelle : prime, remboursement, vente… Le salaire et les aides sont déjà comptés chaque mois.',
    saving: 'Argent mis de côté sur un livret ou une tirelire, ou repris de votre épargne.',
  };

  function renderAdd() {
    const editing = ui.editingId ? state.transactions.find((t) => t.id === ui.editingId) : null;
    if (ui.editingId && !editing) ui.editingId = null;

    let kind = ui.addType;
    let dir = ui.saveDir;
    if (editing) {
      kind = editing.type === 'withdrawal' ? 'saving' : editing.type;
      dir = editing.type === 'withdrawal' ? 'out' : 'in';
    }
    const t = editing || {
      amount: 0,
      categoryId: ui.lastCategoryId && categoryById(ui.lastCategoryId) ? ui.lastCategoryId : null,
      date: ui.month === currentMonth() ? todayISO() : `${ui.month}-01`,
      note: '',
    };

    const chips = state.categories.map((c) => `
      <label class="chip">
        <input type="radio" name="cat" value="${esc(c.id)}" ${c.id === t.categoryId ? 'checked' : ''}>
        <span><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>
      </label>`).join('');

    const seg = (name, options, value) => `
      <div class="segmented" data-seg="${name}" role="group">
        ${options.map(([v, label]) => `<button type="button" data-value="${v}" class="${v === value ? 'active' : ''}" aria-pressed="${v === value}">${label}</button>`).join('')}
      </div>`;

    $('#view-add').innerHTML = `
      <form id="tx-form" novalidate autocomplete="off">
        ${seg('kind', [['expense', 'Dépense'], ['income', 'Rentrée'], ['saving', 'Épargne']], kind)}
        <div id="dir-wrap" ${kind === 'saving' ? '' : 'hidden'}>
          ${seg('dir', [['in', 'Mettre de côté'], ['out', 'Retirer']], dir)}
        </div>
        <p class="note" id="add-hint">${ADD_HINTS[kind]}</p>

        <label class="amount-field">
          <span class="note">Montant (${esc(currencySymbol())})</span>
          <input id="tx-amount" inputmode="decimal" placeholder="0" value="${centsToInput(t.amount)}">
        </label>

        <fieldset id="tx-cats" ${kind === 'expense' ? '' : 'hidden'}>
          <legend>Catégorie</legend>
          <div class="chips">${chips}</div>
        </fieldset>

        <label class="field">
          <span>Date</span>
          <input type="date" id="tx-date" value="${esc(t.date)}" required>
        </label>
        <label class="field">
          <span>Note (facultatif)</span>
          <input id="tx-note" maxlength="120" value="${esc(t.note)}" placeholder="${kind === 'income' ? 'prime de fin d’année' : kind === 'saving' ? 'livret' : 'marché du samedi'}">
        </label>

        <p id="tx-error" class="error" role="alert"></p>
        <button type="submit" class="btn primary">${editing ? 'Enregistrer' : 'Ajouter'}</button>
        ${editing ? `
          <div class="row-btns">
            <button type="button" class="btn" id="tx-cancel">Annuler</button>
            <button type="button" class="btn danger" id="tx-delete">Supprimer</button>
          </div>` : ''}
      </form>`;

    const form = $('#tx-form');
    form.dataset.kind = kind;
    form.dataset.dir = dir;

    $$('.segmented', form).forEach((segEl) => segEl.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      $$('button', segEl).forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', String(b === btn));
      });
      if (segEl.dataset.seg === 'kind') {
        const k = btn.dataset.value;
        form.dataset.kind = k;
        if (!editing) ui.addType = k;
        $('#dir-wrap').hidden = k !== 'saving';
        $('#tx-cats').hidden = k !== 'expense';
        $('#add-hint').textContent = ADD_HINTS[k];
        $('#tx-note').placeholder = k === 'income' ? 'prime de fin d’année' : k === 'saving' ? 'livret' : 'marché du samedi';
      } else {
        form.dataset.dir = btn.dataset.value;
        if (!editing) ui.saveDir = btn.dataset.value;
      }
    }));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#tx-error');
      const amount = parseAmount($('#tx-amount').value.trim());
      const date = $('#tx-date').value;
      const k = form.dataset.kind;
      const checked = $('input[name="cat"]:checked', form);
      if (Number.isNaN(amount) || amount <= 0) { err.textContent = 'Indiquez un montant (exemple : 12,50).'; return; }
      if (k === 'expense' && !checked) { err.textContent = 'Choisissez une catégorie.'; return; }
      if (!isValidISODate(date)) { err.textContent = 'Choisissez une date.'; return; }
      const type = k === 'saving' ? (form.dataset.dir === 'out' ? 'withdrawal' : 'saving') : k;
      if (type === 'withdrawal' && !editing && amount > savingsTotal()) {
        if (!confirm(`Vous retirez plus que votre épargne enregistrée (${money(savingsTotal())}). Continuer ?`)) return;
      }

      const entry = {
        id: editing ? editing.id : uid(),
        type,
        date,
        amount,
        categoryId: type === 'expense' ? checked.value : null,
        note: $('#tx-note').value.trim().slice(0, 120),
      };
      if (editing) state.transactions[state.transactions.indexOf(editing)] = entry;
      else state.transactions.push(entry);
      if (!save()) return;
      if (entry.categoryId) ui.lastCategoryId = entry.categoryId;

      const labels = { expense: 'Dépense ajoutée', income: 'Rentrée ajoutée', saving: 'Épargne ajoutée', withdrawal: 'Retrait noté' };
      const where = entry.date.slice(0, 7) === ui.month ? '' : ` (${monthLabel(entry.date.slice(0, 7))})`;
      if (editing) {
        ui.editingId = null;
        ui.month = entry.date.slice(0, 7);
        toast('Modification enregistrée');
        show('history');
      } else {
        toast(labels[type] + where);
        $('#tx-amount').value = '';
        $('#tx-note').value = '';
        err.textContent = '';
      }
    });

    if (editing) {
      $('#tx-cancel').addEventListener('click', () => { ui.editingId = null; show('history'); });
      $('#tx-delete').addEventListener('click', () => {
        if (!confirm('Supprimer cette opération ?')) return;
        state.transactions = state.transactions.filter((x) => x.id !== editing.id);
        save();
        ui.editingId = null;
        toast('Opération supprimée');
        show('history');
      });
    }
  }

  /* ---------- Épargne ---------- */

  function renderSavings() {
    const cm = currentMonth();
    const total = savingsTotal();
    const s = summary(cm);
    const target = state.savingsTarget;

    const rows = [];
    const first = firstMonth();
    for (let m = cm, n = 0; m >= first && n < 12; m = shiftMonth(m, -1), n++) {
      const sm = m === cm ? s : summary(m);
      const leftover = m < cm && sm.remaining > 0 ? sm.remaining : 0;
      rows.push(`
        <div class="line month-row">
          <span>${monthLabel(m)}</span>
          <span class="num">
            <span class="${sm.savedNet > 0 ? 'pos' : sm.savedNet < 0 ? 'neg' : 'muted'}">${sm.savedNet > 0 ? '+' : sm.savedNet < 0 ? '−' : ''}${money(Math.abs(sm.savedNet))}</span>
            ${leftover ? `<small>non dépensé ${money(leftover)}</small>` : ''}
          </span>
        </div>`);
    }

    $('#view-savings').innerHTML = `
      <section class="hero">
        <p class="eyebrow">Épargne totale</p>
        <p class="big num${total < 0 ? ' neg' : ''}">${money(total)}</p>
        <p class="sub">${state.savingsStart ? `dont ${money(state.savingsStart)} de départ` : 'mis de côté depuis le début'}</p>
      </section>

      <section class="block">
        <h2 class="sec">Évolution</h2>
        ${savingsChartHTML()}
      </section>

      <section class="block">
        <h2 class="sec">Ce mois-ci</h2>
        <div class="line"><span>Mis de côté</span><span class="num">${money(Math.max(s.savedNet, 0))}${target ? ` <span class="muted">/ ${money(target)}</span>` : ''}</span></div>
        ${target ? bar(Math.max(s.savedNet, 0), target, 'save') : '<p class="note">Aucun objectif mensuel. Vous pouvez en fixer un dans Réglages.</p>'}
        <div class="row-btns" style="margin-top:16px">
          <button type="button" class="btn primary" data-go="save">Mettre de côté</button>
          <button type="button" class="btn" data-go="withdraw">Retirer</button>
        </div>
      </section>

      <section class="block">
        <h2 class="sec">Mois par mois</h2>
        ${rows.join('')}
        <p class="note">« Non dépensé » : l’argent qui vous restait en fin de mois. S’il est encore sur votre compte, pensez à le mettre de côté.</p>
      </section>`;

    bindGo($('#view-savings'));
  }

  /* ---------- Historique ---------- */

  function renderHistory() {
    const s = summary(ui.month);
    const tx = s.tx
      .map((t, i) => ({ t, i }))
      .sort((a, b) => (b.t.date.localeCompare(a.t.date)) || (b.i - a.i))
      .map((x) => x.t);

    const head = `
      <section class="block">
        <div class="line"><span>Dépenses du quotidien</span><span class="num">−${money(s.varSpent)}</span></div>
        <div class="line"><span>Rentrées ponctuelles</span><span class="num">+${money(s.extraIncome)}</span></div>
        <div class="line"><span>Épargne</span><span class="num">${money(s.savedNet)}</span></div>
        <p class="note">Les rentrées et dépenses fixes sont comptées automatiquement : voir l’onglet Mois.</p>
      </section>`;

    if (!tx.length) {
      $('#view-history').innerHTML = `${head}<p class="empty">Aucune opération notée ce mois-ci.</p>`;
      return;
    }

    const groups = [];
    for (const t of tx) {
      const last = groups[groups.length - 1];
      if (last && last.date === t.date) last.items.push(t);
      else groups.push({ date: t.date, items: [t] });
    }

    const rowHTMLTx = (t) => {
      const cat = t.type === 'expense' ? categoryById(t.categoryId) : null;
      const label = { income: 'Rentrée', saving: 'Mis de côté', withdrawal: 'Retrait d’épargne' }[t.type] || (cat ? cat.name : 'Sans catégorie');
      const sign = t.type === 'income' || t.type === 'withdrawal' ? '+' : '−';
      const cls = t.type === 'income' ? ' pos' : '';
      return `
        <button type="button" class="tx-row" data-id="${esc(t.id)}">
          <span class="dot" style="background:${esc(cat ? cat.color : 'var(--muted)')}"></span>
          <span class="info">
            <span class="t">${esc(label)}</span>
            ${t.note ? `<span class="n">${esc(t.note)}</span>` : ''}
          </span>
          <span class="num amt${cls}">${sign}${money(t.amount)}</span>
        </button>`;
    };

    $('#view-history').innerHTML = `
      ${head}
      ${groups.map((g) => `
        <h3 class="day">${esc(capitalize(dayLabel(g.date)))}</h3>
        <div class="tx-list">${g.items.map(rowHTMLTx).join('')}</div>`).join('')}
      <p class="note center">Touchez une opération pour la modifier.</p>`;

    $$('.tx-row', $('#view-history')).forEach((row) => row.addEventListener('click', () => {
      ui.editingId = row.dataset.id;
      show('add');
    }));
  }

  /* ---------- Réglages ---------- */

  function renderSettings() {
    const cm = currentMonth();
    const o = { currency: state.currency };
    const active = (list) => list.filter((i) => isActive(i, cm));

    $('#view-settings').innerHTML = `
      <section class="block">
        <h2 class="sec">Rentrées chaque mois <span class="muted" id="t-income"></span></h2>
        ${editorHTML('income', active(state.incomes), { ...o, placeholder: 'Nom de la rentrée' })}
      </section>
      <section class="block">
        <h2 class="sec">Dépenses fixes chaque mois <span class="muted" id="t-fixed"></span></h2>
        ${editorHTML('fixed', active(state.fixed), { ...o, placeholder: 'Nom de la dépense' })}
      </section>
      <section class="block">
        <h2 class="sec">Budget du quotidien <span class="muted" id="t-cat"></span></h2>
        ${editorHTML('cat', state.categories, { ...o, placeholder: 'Nom de la catégorie' })}
      </section>
      <section class="block">
        <h2 class="sec">Épargne</h2>
        <label class="field"><span>Objectif chaque mois</span>
          <span class="money"><input id="set-target" inputmode="decimal" placeholder="0" value="${centsToInput(state.savingsTarget)}" autocomplete="off"><span class="cur">${esc(currencySymbol())}</span></span></label>
        <label class="field"><span>Épargne de départ</span>
          <span class="money"><input id="set-start" inputmode="decimal" placeholder="0" value="${centsToInput(state.savingsStart)}" autocomplete="off"><span class="cur">${esc(currencySymbol())}</span></span></label>
        <label class="field"><span>Devise</span><select id="set-currency">${currencyOptions(state.currency)}</select></label>
      </section>

      <section class="block">
        <h2 class="sec">Votre plan chaque mois</h2>
        <div id="set-plan"></div>
        <p class="note">Les changements de rentrées et de dépenses fixes s’appliquent à partir de ${monthLabel(cm)} : les mois passés ne bougent pas.</p>
      </section>

      <p id="set-error" class="error" role="alert"></p>
      <button type="button" class="btn primary" id="set-save">Enregistrer</button>

      <section class="block" style="margin-top:40px">
        <h2 class="sec">Sauvegarde</h2>
        <p class="note">Vos données sont uniquement sur ce téléphone. Exportez régulièrement un fichier (par exemple dans Fichiers ou iCloud Drive) pour ne rien perdre et pour changer d’appareil.</p>
        <div class="row-btns">
          <button type="button" class="btn" id="btn-export">Exporter</button>
          <button type="button" class="btn" id="btn-import">Importer</button>
        </div>
      </section>

      <section class="block">
        <h2 class="sec">Tout recommencer</h2>
        <p class="note">Efface toutes les données de ce téléphone et relance le parcours de départ.</p>
        <button type="button" class="btn danger" id="btn-reset">Tout effacer</button>
      </section>`;

    const root = $('#view-settings');
    const refresh = () => {
      $('#t-income', root).textContent = money(sumEditor(root, 'income'));
      $('#t-fixed', root).textContent = money(sumEditor(root, 'fixed'));
      $('#t-cat', root).textContent = money(sumEditor(root, 'cat'));
      const t = readMoneyInput($('#set-target', root));
      $('#set-plan', root).innerHTML = planHTML({
        inc: sumEditor(root, 'income'),
        fix: sumEditor(root, 'fixed'),
        varp: sumEditor(root, 'cat'),
        save: Number.isNaN(t) ? 0 : t,
      });
    };

    bindEditor(root, 'income', { ...o, suggestions: SUGGEST.income, placeholder: 'Nom de la rentrée' }, refresh);
    bindEditor(root, 'fixed', { ...o, suggestions: SUGGEST.fixed, placeholder: 'Nom de la dépense' }, refresh);
    bindEditor(root, 'cat', {
      ...o,
      suggestions: SUGGEST.cat,
      withColor: true,
      placeholder: 'Nom de la catégorie',
      onDelete: (row) => {
        const used = state.transactions.some((t) => t.categoryId === row.dataset.id);
        const name = $('.e-name', row).value.trim() || 'cette catégorie';
        return !used || confirm(`« ${name} » contient des dépenses. Elles resteront dans l’historique en « Sans catégorie ». Retirer ?`);
      },
    }, refresh);
    $('#set-target', root).addEventListener('input', refresh);
    $('#set-currency', root).addEventListener('change', (e) => {
      const sym = currencySymbol(e.target.value);
      $$('.cur', root).forEach((el) => { el.textContent = sym; });
    });
    refresh();

    $('#set-save', root).addEventListener('click', () => {
      const err = $('#set-error', root);
      const ri = readEditor(root, 'income', { what: 'Rentrées' });
      const rf = readEditor(root, 'fixed', { what: 'Dépenses fixes' });
      const rc = readEditor(root, 'cat', { min: 1, what: 'Budget du quotidien' });
      const firstError = [ri, rf, rc].find((r) => r.error);
      if (firstError) { err.textContent = firstError.error; return; }
      const target = readMoneyInput($('#set-target', root));
      const startAmount = readMoneyInput($('#set-start', root));
      if (Number.isNaN(target)) { err.textContent = 'Objectif d’épargne invalide.'; return; }
      if (Number.isNaN(startAmount)) { err.textContent = 'Épargne de départ invalide.'; return; }

      state.incomes = applyRecurring(state.incomes, ri.items, cm);
      state.fixed = applyRecurring(state.fixed, rf.items, cm);
      state.categories = rc.items.map(({ id, name, amount, color }, i) => ({ id, name, budget: amount, color: color || PALETTE[i % PALETTE.length] }));
      state.savingsTarget = target;
      state.savingsStart = startAmount;
      state.currency = $('#set-currency', root).value;
      if (!save()) return;
      toast('Réglages enregistrés');
      renderSettings();
    });

    $('#btn-export', root).addEventListener('click', exportData);
    $('#btn-import', root).addEventListener('click', () => $('#import-file').click());
    $('#btn-reset', root).addEventListener('click', () => {
      if (!confirm('Effacer toutes les rentrées, dépenses et l’épargne enregistrées sur ce téléphone ?')) return;
      if (!confirm('Dernière confirmation : c’est définitif. Avez-vous exporté une sauvegarde ?')) return;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignoré */ }
      state = null;
      start();
    });
  }

  /* ---------- Export / import ---------- */

  async function exportData() {
    const payload = { app: 'budget-mensuel', exportedAt: new Date().toISOString(), ...state };
    const name = `budget-${todayISO()}.json`;
    const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

    // Sur iPhone, la feuille de partage permet « Enregistrer dans Fichiers ».
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        return;
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function importFile(file) {
    if (file.size > MAX_IMPORT_BYTES) { alert('Import impossible : fichier trop volumineux.'); return; }
    let data;
    try {
      data = validate(JSON.parse(await file.text()));
    } catch (e) {
      alert(`Import impossible : ${e instanceof SyntaxError ? 'le fichier n’est pas un JSON valide.' : e.message}`);
      return;
    }
    const summaryText = `${plural(data.incomes.length, 'rentrée')}, ${plural(data.fixed.length, 'dépense fixe')}, ${plural(data.categories.length, 'catégorie')} et ${plural(data.transactions.length, 'opération')}`;
    const warning = state ? '\n\nLes données actuelles de ce téléphone seront remplacées.' : '';
    if (!confirm(`Importer ${summaryText} ?${warning}`)) return;
    state = data;
    if (!save()) return;
    requestPersistence();
    ui.month = currentMonth();
    start();
    toast('Import terminé');
  }

  /* ---------- Démarrage ---------- */

  function requestPersistence() {
    // Demande au navigateur de ne pas effacer les données automatiquement (si supporté).
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function start() {
    $('#setup').hidden = !!state;
    $('#main').hidden = !state;
    if (state) {
      ui.editingId = null;
      show('month');
    } else {
      ui.step = 0;
      ui.draft = newDraft();
      renderSetup();
      window.scrollTo(0, 0);
    }
  }

  /** Bloque le zoom (pincement à deux doigts), comme dans une app : Safari ignore user-scalable=no. */
  function blockZoom() {
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
    }
    document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  }

  function init() {
    blockZoom();
    state = load();
    if (state) save(); // enregistre au format courant (migration des anciennes versions)

    $$('.tab').forEach((t) => t.addEventListener('click', () => {
      ui.editingId = null;
      show(t.dataset.view);
    }));
    $('#prev-month').addEventListener('click', () => goMonth(-1));
    $('#next-month').addEventListener('click', () => goMonth(1));
    bindDialog();

    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importFile(file);
    });

    // Retour sur l’app un autre mois : on recale sur le mois courant.
    let lastMonth = currentMonth();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !state) return;
      const now = currentMonth();
      if (now !== lastMonth) { lastMonth = now; ui.month = now; render(); }
    });

    start();

    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
