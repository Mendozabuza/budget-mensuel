/*
 * Budget mensuel — application sans serveur.
 * Toutes les données sont stockées dans le localStorage du navigateur, sur l’appareil.
 * Les montants sont stockés en centimes (entiers) pour éviter les erreurs d’arrondi.
 *
 * Modèle (version 3) :
 *  - incomes / fixed : rentrées et dépenses fixes habituelles (nom, montant, jour du mois).
 *  - categories : postes à budgéter chaque mois (courses, loisirs…).
 *  - months[mois] : le budget validé d’un mois — montants reçus et prélevés ce mois-là,
 *    plan choisi, épargne prévue (et si le virement est fait), budget par catégorie.
 *  - bank : dernier solde du compte courant recopié depuis l’app de la banque.
 *  - savings : soldes du livret recopiés au fil du temps (pour la courbe).
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'budget-mensuel';
  const SCHEMA_VERSION = 3;
  const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

  const PALETTE = ['#2f855a', '#2b6cb0', '#c05621', '#6b46c1', '#b83280', '#2c7a7b', '#b7791f', '#718096', '#4c51bf', '#c53030'];
  const CURRENCIES = ['EUR', 'CHF', 'CAD', 'USD', 'GBP', 'MAD', 'XOF'];
  const SUGGEST = {
    income: ['Salaire', 'Allocation chômage', 'APL', 'Prime d’activité', 'Allocations familiales', 'Pension alimentaire', 'Retraite', 'Bourse', 'Autre revenu'],
    fixed: ['Loyer', 'Électricité', 'Gaz', 'Eau', 'Internet', 'Téléphone', 'Assurance habitation', 'Assurance auto', 'Mutuelle', 'Transport en commun', 'Streaming', 'Salle de sport', 'Crédit', 'Impôts', 'Frais bancaires'],
    cat: ['Courses', 'Tabac', 'Carburant', 'Restaurants', 'Loisirs', 'Santé', 'Vêtements', 'Enfants', 'Animaux', 'Cadeaux', 'Divers'],
  };
  const DEFAULT_CATS = ['Courses', 'Loisirs', 'Divers'];

  /* Emojis : devinés d’après le nom (le premier qui correspond), modifiables en touchant l’emoji. */
  const EMOJI_RULES = [
    [/assurance/i, '🛡️'], [/loyer|logement/i, '🏠'], [/[ée]lectricit|\bedf\b/i, '⚡'], [/\bgaz\b/i, '🔥'], [/\beau\b/i, '💧'],
    [/internet|\bbox\b|wifi|fibre/i, '🌐'], [/t[ée]l[ée]phone|mobile|forfait/i, '📱'], [/mutuelle|sant[ée]|m[ée]decin/i, '🩺'],
    [/pharmac/i, '💊'], [/transport|navigo|\bbus\b|train|m[ée]tro/i, '🚆'], [/streaming|netflix|spotify|disney|canal/i, '📺'],
    [/sport|salle/i, '🏋️'], [/cr[ée]dit|pr[êe]t\b|banc|banque/i, '🏦'], [/imp[ôo]t|taxe/i, '🧾'], [/caf[ée]/i, '☕'],
    [/salaire|paie/i, '💼'], [/ch[ôo]mage|france travail|p[ôo]le emploi/i, '🏛️'], [/\bapl\b|\bcaf\b/i, '🏠'], [/prime/i, '⭐'],
    [/familial|enfant|cr[èe]che/i, '👶'], [/pension/i, '🤝'], [/retraite/i, '🧓'], [/bourse|[ée]cole|[ée]tude/i, '🎓'],
    [/course|supermarch|aliment/i, '🛒'], [/tabac|cigarette|clope/i, '🚬'], [/carburant|essence|gasoil/i, '⛽'],
    [/restau|resto/i, '🍽️'], [/loisir|sortie/i, '🎉'], [/v[êe]tement|habit/i, '👕'], [/animau|\bchats?\b|\bchiens?\b/i, '🐾'],
    [/cadeau/i, '🎁'], [/laverie|pressing/i, '🧺'], [/voiture|\bauto\b/i, '🚗'], [/coiff/i, '💇'], [/divers/i, '📦'],
  ];
  const DEFAULT_EMOJI = { income: '💶', fixed: '💸', cat: '🛍️' };
  const EMOJI_CHOICES = ['💼', '🏛️', '💶', '⭐', '🤝', '🎓', '🏠', '⚡', '🔥', '💧', '🌐', '📱', '🛡️', '🩺', '💊', '🚆', '🚗', '⛽',
    '📺', '🏋️', '🏦', '🧾', '💸', '💳', '🛒', '🚬', '🍽️', '☕', '🍺', '🎉', '🎬', '🎮', '👕', '👶', '🐾', '🎁', '🧺', '💇',
    '✈️', '📚', '🔧', '📦', '🛍️', '💰'];

  const guessEmoji = (name) => (EMOJI_RULES.find(([re]) => re.test(name || '')) || [])[1];
  /** L’emoji choisi, sinon celui deviné d’après le nom, sinon celui par défaut. */
  const emojiOf = (item, kind) => item.emoji || guessEmoji(item.name) || DEFAULT_EMOJI[kind];
  const emo = (item, kind) => `<span class="emo" aria-hidden="true">${esc(emojiOf(item, kind))}</span>`;
  const VIEWS = ['month', 'savings', 'settings', 'edit'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  let state = null;
  const ui = {
    view: 'month',
    month: currentMonth(),
    editStep: 1,   // budget du mois : 1 = montants, 2 = répartition
    editDraft: null,
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

  /** « de novembre », « d’octobre ». */
  function ofMonth(month) {
    const name = monthName(month);
    return /^[aeiouy]/i.test(name) ? `d’${name}` : `de ${name}`;
  }

  function shortDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
  }

  /** Jours écoulés depuis une date AAAA-MM-JJ. */
  function daysSince(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const now = new Date();
    return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(y, m - 1, d)) / 86400000);
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
    const s = String(str ?? '').replace(/[\s  ]/g, '').replace(',', '.');
    if (!/^\d+(\.\d{0,2})?$/.test(s)) return NaN;
    return Math.round(parseFloat(s) * 100);
  }

  function centsToInput(cents) {
    if (!cents) return '';
    return (cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');
  }

  function readMoneyInput(el) {
    const raw = el.value.trim();
    return raw ? parseAmount(raw) : 0;
  }

  function activeCurrency() {
    return (state && state.currency) || (ui.draft && ui.draft.currency) || 'EUR';
  }

  function money(cents, currency = activeCurrency()) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
  }

  /** Montant sans centimes, pour les repères (« environ 95 € par semaine »). */
  function roundMoney(cents) {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: activeCurrency(), maximumFractionDigits: 0 }).format(cents / 100);
  }

  function currencySymbol(currency = activeCurrency()) {
    const part = new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).formatToParts(0).find((p) => p.type === 'currency');
    return part ? part.value : currency;
  }

  function currencyOptions(selected) {
    return CURRENCIES.map((c) => `<option value="${c}" ${c === selected ? 'selected' : ''}>${c} (${esc(currencySymbol(c))})</option>`).join('');
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const fx = (n) => (Math.round(n * 10) / 10).toString();

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

  const isCents = (n) => Number.isInteger(n) && n >= 0;
  const isSignedCents = (n) => Number.isInteger(n) && Math.abs(n) < 1e11;
  const cleanName = (s) => (typeof s === 'string' ? s.trim().slice(0, 40) : '') || 'Sans nom';
  const cleanDay = (d) => (Number.isInteger(d) && d >= 1 && d <= 31 ? d : null);
  const cleanEmoji = (e) => (typeof e === 'string' && e.trim() && e.length <= 16 ? e.trim() : null);

  /** Garde les montants d’un mois qui correspondent à une ligne connue. */
  function cleanAmounts(o, ids) {
    const out = {};
    if (o && typeof o === 'object') for (const id of ids) if (isCents(o[id])) out[id] = o[id];
    return out;
  }

  /** Vérifie et normalise des données (stockage local ou import). Lève une Error lisible si invalide. */
  function validate(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('le contenu n’est pas un objet JSON.');
    if (d.version !== SCHEMA_VERSION) return migrate(d);

    const recurring = (list, label) => {
      if (!Array.isArray(list)) throw new Error(`le champ « ${label} » doit être une liste.`);
      return list.map((r, i) => {
        if (!r || typeof r.id !== 'string' || !isCents(r.amount)) throw new Error(`${label} n°${i + 1} invalide.`);
        return { id: r.id, name: cleanName(r.name), amount: r.amount, day: cleanDay(r.day), emoji: cleanEmoji(r.emoji) };
      });
    };
    const incomes = recurring(d.incomes, 'incomes');
    const fixed = recurring(d.fixed, 'fixed');
    if (!Array.isArray(d.categories)) throw new Error('le champ « categories » doit être une liste.');
    const categories = d.categories.map((c, i) => {
      if (!c || typeof c.id !== 'string') throw new Error(`catégorie n°${i + 1} invalide.`);
      const per = ['month', 'week'].includes(c.per) && isCents(c.amount) ? c.per : null;
      return { id: c.id, name: cleanName(c.name), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[i % PALETTE.length], per, amount: per ? c.amount : null, emoji: cleanEmoji(c.emoji) };
    });

    const months = {};
    const done = {};
    if (d.done && typeof d.done === 'object') {
      for (const [m, ids] of Object.entries(d.done)) {
        if (isMonth(m) && Array.isArray(ids)) done[m] = [...new Set(ids.filter((x) => typeof x === 'string'))];
      }
    }
    if (d.months && typeof d.months === 'object') {
      for (const [m, r] of Object.entries(d.months)) {
        if (!isMonth(m) || !r || typeof r !== 'object') continue;
        months[m] = {
          incomes: cleanAmounts(r.incomes, incomes.map((x) => x.id).concat(Object.keys(r.incomes || {}))),
          fixed: cleanAmounts(r.fixed, fixed.map((x) => x.id).concat(Object.keys(r.fixed || {}))),
          plan: Object.prototype.hasOwnProperty.call(PLANS, r.plan) ? r.plan : 'equilibre',
          save: isCents(r.save) ? r.save : 0,
          budgets: cleanAmounts(r.budgets, Object.keys(r.budgets || {})),
        };
        if (r.saveDone === true) done[m] = [...new Set([...(done[m] || []), 'save'])]; // ancien format
      }
    }

    const savings = (Array.isArray(d.savings) ? d.savings : [])
      .filter((p) => p && isValidISODate(p.date) && isSignedCents(p.amount))
      .map((p) => ({ date: p.date, amount: p.amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      version: SCHEMA_VERSION,
      currency: CURRENCIES.includes(d.currency) ? d.currency : 'EUR',
      incomes,
      fixed,
      categories,
      plan: Object.prototype.hasOwnProperty.call(PLANS, d.plan) ? d.plan : 'equilibre',
      months,
      done,
      bank: d.bank && isSignedCents(d.bank.amount) && isValidISODate(d.bank.date) ? { amount: d.bank.amount, date: d.bank.date } : null,
      savings,
      createdAt: isValidISODate(d.createdAt) ? d.createdAt : todayISO(),
      lastBackup: isValidISODate(d.lastBackup) ? d.lastBackup : null,
    };
  }

  /**
   * Reprend les données des versions précédentes (qui notaient chaque dépense) :
   * on garde rentrées, dépenses fixes, catégories, budgets du mois, solde du compte
   * et total d’épargne. Le détail des dépenses n’est plus utilisé.
   */
  function migrate(d) {
    if (!Array.isArray(d.categories)) throw new Error('fichier non reconnu (catégories manquantes).');
    const cm = currentMonth();
    const active = (r) => !(isMonth(r.until) && r.until < cm);
    const recurring = (list) => (Array.isArray(list) ? list : [])
      .filter((r) => r && typeof r.id === 'string' && isCents(r.amount) && active(r))
      .map((r) => ({ id: r.id, name: cleanName(r.name), amount: r.amount, day: cleanDay(r.day) }));
    const incomes = recurring(d.incomes);
    const fixed = recurring(d.fixed);
    const categories = d.categories
      .filter((c) => c && typeof c.id === 'string')
      .map((c, i) => ({ id: c.id, name: cleanName(c.name), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : PALETTE[i % PALETTE.length], budget: isCents(c.budget) ? c.budget : 0 }));

    const over = (d.overrides && d.overrides[cm]) || {};
    const amountFor = (r) => (isCents(over[r.id]) ? over[r.id] : r.amount);
    const plan = Object.prototype.hasOwnProperty.call(PLANS, d.plan) ? d.plan : 'equilibre';
    const months = {};
    if (categories.some((c) => c.budget > 0) || isCents(d.savingsTarget)) {
      months[cm] = {
        incomes: Object.fromEntries(incomes.map((r) => [r.id, amountFor(r)])),
        fixed: Object.fromEntries(fixed.map((r) => [r.id, amountFor(r)])),
        plan,
        save: isCents(d.savingsTarget) ? d.savingsTarget : 0,
        budgets: Object.fromEntries(categories.map((c) => [c.id, c.budget])),
      };
    }

    // Total d’épargne connu = point de départ de la courbe.
    const tx = Array.isArray(d.transactions) ? d.transactions : [];
    const total = (isCents(d.savingsStart) ? d.savingsStart : 0) +
      sum(tx, (t) => (t && Number.isInteger(t.amount) ? (t.type === 'saving' ? t.amount : t.type === 'withdrawal' ? -t.amount : 0) : 0));
    const savings = total ? [{ date: todayISO(), amount: total }] : [];

    return validate({
      version: SCHEMA_VERSION,
      currency: d.currency,
      incomes,
      fixed,
      categories: categories.map(({ id, name, color }) => ({ id, name, color, per: null, amount: null })),
      plan,
      months,
      bank: d.bank,
      savings,
      createdAt: todayISO(),
      lastBackup: d.lastBackup,
    });
  }

  function load() {
    let raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { return null; }
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version !== SCHEMA_VERSION) {
        // Avant de simplifier les données, on garde l’ancienne version telle quelle.
        try { localStorage.setItem(`${STORAGE_KEY}:avant-v${SCHEMA_VERSION}`, raw); } catch { /* stockage plein */ }
      }
      return validate(parsed);
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

  /* ---------- Le budget d’un mois ---------- */

  /** Dernier mois validé avant `month` (pour reprendre ses montants), ou null. */
  function previousRecord(month) {
    const keys = Object.keys(state.months).filter((m) => m < month).sort();
    return keys.length ? state.months[keys[keys.length - 1]] : null;
  }

  /**
   * Budget d’un mois : celui validé s’il existe, sinon une proposition
   * (montants du dernier mois validé ou habituels, plan proposé).
   */
  function budgetFor(month) {
    const rec = state.months[month];
    const prev = rec || previousRecord(month);
    const pick = (list, key) => list.map((item) => ({
      item,
      amount: prev && isCents(prev[key][item.id]) ? prev[key][item.id] : item.amount,
    }));
    const incomes = pick(state.incomes, 'incomes');
    const fixed = pick(state.fixed, 'fixed');
    const income = sum(incomes, (x) => x.amount);
    const fixedTotal = sum(fixed, (x) => x.amount);
    const planKey = (rec && rec.plan) || state.plan;
    let saveAmount, budgets;
    if (rec) {
      saveAmount = rec.save;
      budgets = new Map(state.categories.map((c) => [c.id, rec.budgets[c.id] || 0]));
    } else {
      const p = proposePlan(planKey, { income, fixed: fixedTotal, cats: state.categories });
      saveAmount = p.save;
      budgets = p.budgets;
    }
    const free = income - fixedTotal;
    const margin = free - saveAmount - sum([...budgets.values()], (x) => x);
    return { month, confirmed: !!rec, incomes, fixed, income, fixedTotal, free, plan: planKey, save: saveAmount, saveDone: isDone(month, 'save'), budgets, margin };
  }

  /** Prélèvement (ou virement d’épargne : 'save') déjà passé ce mois-ci, indiqué par vous. */
  const isDone = (month, id) => !!(state.done[month] && state.done[month].includes(id));

  function toggleDone(month, id) {
    const list = state.done[month] || [];
    state.done[month] = list.includes(id) ? list.filter((x) => x !== id) : list.concat(id);
    if (!state.done[month].length) delete state.done[month];
    save();
  }

  /**
   * Combien dépenser par jour, d’après le solde recopié de l’app bancaire.
   * Calcul prudent : l’argent qui n’est pas encore arrivé n’est pas compté.
   * Une dépense fixe prélevée le jour même ou sans jour indiqué compte comme « encore à venir »,
   * sauf si vous indiquez qu’elle est déjà passée.
   */
  function dailyAllowance(b) {
    const bank = state.bank;
    if (!bank || bank.date.slice(0, 7) !== b.month) return null;
    const day = Number(bank.date.slice(8));
    const daysLeft = daysInMonth(b.month) - day + 1;
    const byDay = (x, y) => (x.item.day || 99) - (y.item.day || 99);
    const toCome = b.fixed.filter((x) => x.amount > 0 && (!x.item.day || Math.min(x.item.day, daysInMonth(b.month)) >= day)).sort(byDay);
    const fixedToCome = sum(toCome.filter((x) => !isDone(b.month, x.item.id)), (x) => x.amount);
    const saveToCome = b.saveDone ? 0 : b.save;
    const left = bank.amount - fixedToCome - saveToCome;
    // Rentrées encore attendues : affichées pour information, jamais comptées.
    const incomesToCome = b.incomes.filter((x) => x.amount > 0 && x.item.day && Math.min(x.item.day, daysInMonth(b.month)) > day).sort(byDay);
    return { bank, day, daysLeft, toCome, fixedToCome, saveToCome, incomesToCome, left, perDay: left > 0 ? Math.floor(left / daysLeft) : 0 };
  }

  /* ---------- Plans : épargne et budgets proposés ---------- */

  // Le « risque », c’est celui de finir le mois à court : plus on épargne, plus la marge est mince.
  const PLANS = {
    prudent: { label: 'Prudent', save: 0.05, cushion: 0.15, text: 'Peu de risque de finir le mois à court : on épargne un peu et on garde une grosse marge pour les imprévus.' },
    equilibre: { label: 'Équilibré', save: 0.10, cushion: 0.10, text: 'Un juste milieu entre mettre de côté et garder de la marge.' },
    effort: { label: 'Effort', save: 0.20, cushion: 0.05, text: 'On épargne beaucoup, mais la marge pour les imprévus est petite. À éviter si vos rentrées ou vos dépenses changent beaucoup d’un mois à l’autre.' },
  };

  /** Arrondi à la dizaine inférieure (montants en centimes). */
  const tens = (cents) => Math.max(0, Math.floor(cents / 1000) * 1000);

  /**
   * Propose une répartition de ce qui reste après les dépenses fixes :
   * l’épargne d’abord, puis les catégories (les courses pèsent plus), le reste en marge.
   * Tout est arrondi à la dizaine ; les unités et centimes restent dans la marge.
   */
  function proposePlan(key, { income, fixed, cats }) {
    const p = PLANS[key];
    const free = income - fixed;
    const known = cats.filter((c) => c.per);
    const auto = cats.filter((c) => !c.per);
    const budgets = new Map(known.map((c) => [c.id, catMonthly(c)]));
    if (free <= 0) {
      for (const c of auto) budgets.set(c.id, 0);
      return { save: 0, budgets };
    }
    // Les montants que vous connaissez (tabac, courses à 40 € par semaine…) passent en premier.
    const spendable = free * (1 - p.cushion) - sum(known, catMonthly);
    const save = Math.min(tens(income * p.save), tens(spendable / 2)); // jamais plus de la moitié de ce qui est libre
    const rest = Math.max(0, spendable - save);
    const weight = (c) => (/course|aliment|supermarch/i.test(c.name) ? 3 : 1);
    const total = sum(auto, weight) || 1;
    for (const c of auto) budgets.set(c.id, tens(rest * weight(c) / total));
    return { save, budgets };
  }

  /** Montant par mois d’un poste dont vous connaissez le montant (par semaine : 52 semaines / 12 mois, arrondi à l’euro). */
  function catMonthly(c) {
    if (c.per === 'week') return Math.round(c.amount * 52 / 12 / 100) * 100;
    return c.per === 'month' ? c.amount : 0;
  }

  /** « 40 € par semaine », « 45 € par mois ». */
  const knownLabel = (c) => `${roundMoney(c.amount)} par ${c.per === 'week' ? 'semaine' : 'mois'}`;

  /** Écran de répartition : choix du plan, montants modifiables, marge calculée. */
  function allocHTML(ctx, values, planKey) {
    const free = ctx.income - ctx.fixed;
    const field = (attrs, cents, label) => `<span class="money"><input ${attrs} inputmode="decimal" placeholder="0" value="${centsToInput(cents)}" autocomplete="off" aria-label="${esc(label)}"><span class="cur">${esc(currencySymbol())}</span></span>`;
    return `
      <div class="alloc">
        <p class="alloc-head">Rentrées ${money(ctx.income)} − dépenses fixes ${money(ctx.fixed)}</p>
        <p class="alloc-free num${free < 0 ? ' neg' : ''}">${money(free)} <span>à répartir</span></p>
        ${free <= 0 ? '<p class="msg warn">Vos dépenses fixes atteignent ou dépassent vos rentrées : il n’y a rien à répartir.</p>' : ''}
        <div class="segmented plans" role="group" aria-label="Plan">
          ${Object.entries(PLANS).map(([k, p]) => `<button type="button" data-plan="${k}" class="${k === planKey ? 'active' : ''}">${p.label}</button>`).join('')}
        </div>
        <p class="note plan-text">${esc(PLANS[planKey].text)}</p>
        <div class="alloc-rows">
          <h3 class="alloc-sec">Mettre de côté</h3>
          <label class="alloc-row"><span class="alloc-name"><span><span class="emo" aria-hidden="true">🐷</span> Épargne</span><small>virement vers le livret</small></span>${field('data-alloc="save"', values.save, 'Épargne')}</label>
          ${ctx.cats.length ? '<h3 class="alloc-sec">Dépenses de tous les jours</h3>' : ''}
          ${ctx.cats.map((c) => `
            <label class="alloc-row"><span class="alloc-name"><span>${emo(c, 'cat')} ${esc(c.name)}</span>${c.per ? `<small>vous avez indiqué ${esc(knownLabel(c))}</small>` : '<small data-week></small>'}</span>${field(`data-alloc="cat" data-id="${esc(c.id)}"`, values.budgets.get(c.id) || 0, c.name)}</label>`).join('')}
          <div class="alloc-row cushion"><span class="alloc-name">Marge pour les imprévus<small>ce qui n’est pas réparti</small></span><span class="num" data-cushion></span></div>
        </div>
        <p class="msg warn" data-alloc-warn hidden></p>
        <p class="note">Les montants proposés sont arrondis à la dizaine. Vous pouvez les changer.</p>
      </div>`;
  }

  /** Branche l’écran de répartition ; renvoie { read } pour lire les montants choisis. */
  function bindAlloc(root, ctx) {
    let plan = $('.plans .active', root).dataset.plan;
    const inputs = () => $$('[data-alloc]', root);
    const values = () => {
      let save = 0, bad = false;
      const budgets = new Map();
      for (const el of inputs()) {
        const v = readMoneyInput(el);
        if (Number.isNaN(v)) { bad = true; continue; }
        if (el.dataset.alloc === 'save') save = v; else budgets.set(el.dataset.id, v);
      }
      return { save, budgets, bad };
    };
    const refresh = () => {
      const v = values();
      const cushion = ctx.income - ctx.fixed - v.save - sum([...v.budgets.values()], (x) => x);
      for (const el of inputs()) {
        const week = el.closest('.alloc-row').querySelector('[data-week]');
        const n = readMoneyInput(el);
        if (week) week.textContent = n > 0 ? `soit environ ${roundMoney(n * 12 / 52)} par semaine` : '';
      }
      const cell = $('[data-cushion]', root);
      cell.textContent = money(cushion);
      cell.classList.toggle('neg', cushion < 0);
      const warn = $('[data-alloc-warn]', root);
      warn.hidden = cushion >= 0 || ctx.income - ctx.fixed <= 0;
      warn.innerHTML = `Vous répartissez <b>${money(-cushion)}</b> de plus que ce qui est libre. Baissez un montant.`;
    };
    $('.plans', root).addEventListener('click', (e) => {
      const b = e.target.closest('[data-plan]');
      if (!b) return;
      plan = b.dataset.plan;
      $$('.plans button', root).forEach((x) => x.classList.toggle('active', x === b));
      $('.plan-text', root).textContent = PLANS[plan].text;
      const p = proposePlan(plan, ctx);
      for (const el of inputs()) el.value = centsToInput(el.dataset.alloc === 'save' ? p.save : p.budgets.get(el.dataset.id) || 0);
      refresh();
    });
    $('.alloc-rows', root).addEventListener('input', refresh);
    refresh();
    return {
      read() {
        const v = values();
        return { plan, save: v.save, budgets: v.budgets, error: v.bad ? 'Un montant est invalide (exemple : 120).' : '' };
      },
    };
  }

  /* ---------- Éditeur de listes (rentrées, dépenses fixes, catégories) ---------- */

  /** Jour du mois où une rentrée arrive / une dépense est prélevée. */
  const DAY = { income: { dayLabel: 'Arrive' }, fixed: { dayLabel: 'Prélevé' } };

  function rowHTML(item, o, key) {
    const amount = item.amount ?? 0;
    const nameInput = `<input class="e-name" value="${esc(item.name)}" placeholder="${esc(o.placeholder || 'Nom')}" maxlength="40" autocomplete="off" aria-label="Nom">`;
    const per = item.per || 'auto';
    const catLine = o.catAmount ? `
          <div class="e-cat">
            <select class="e-per" aria-label="Montant de ${esc(item.name)}">
              <option value="auto" ${per === 'auto' ? 'selected' : ''}>L’app propose</option>
              <option value="month" ${per === 'month' ? 'selected' : ''}>Je sais, par mois</option>
              <option value="week" ${per === 'week' ? 'selected' : ''}>Je sais, par semaine</option>
            </select>
            <span class="money"${per === 'auto' ? ' hidden' : ''}><input class="e-cat-amt" inputmode="decimal" placeholder="0" value="${per === 'auto' ? '' : centsToInput(item.amount)}" autocomplete="off" aria-label="Montant"><span class="cur">${esc(currencySymbol(o.currency))}</span></span>
          </div>` : '';
    return `
      <div class="erow${o.toggle && !item.on ? ' off' : ''}" data-id="${esc(item.id)}"${item.color ? ` data-color="${esc(item.color)}"` : ''}${item.emoji ? ` data-emoji="${esc(item.emoji)}"` : ''}>
        ${o.toggle ? `<input type="checkbox" class="e-on" ${item.on ? 'checked' : ''} aria-label="Utiliser ${esc(item.name)}">` : ''}
        <button type="button" class="e-emo" aria-label="Changer l’emoji (appui long : déplacer)">${esc(emojiOf(item, key))}</button>
        ${o.dayLabel ? `<div class="e-main">${nameInput}
          <label class="e-day">${o.dayLabel} le <input class="e-day-in" inputmode="numeric" pattern="[0-9]*" maxlength="2" placeholder="…" value="${item.day ?? ''}" autocomplete="off" aria-label="Jour du mois"></label></div>` : o.catAmount ? `<div class="e-main">${nameInput}${catLine}</div>` : nameInput}
        ${o.noAmount ? '' : `<span class="money"><input class="e-amount" inputmode="decimal" placeholder="0" value="${centsToInput(amount)}" autocomplete="off" aria-label="Montant par mois"><span class="cur">${esc(currencySymbol(o.currency))}</span></span>`}
        ${o.toggle ? '' : '<button type="button" class="e-del" aria-label="Retirer cette ligne"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button>'}
      </div>`;
  }

  function editorHTML(key, items, o) {
    return `<div class="editor" data-editor="${key}">${items.map((i) => rowHTML(i, o, key)).join('')}</div>
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
      box.insertAdjacentHTML('beforeend', rowHTML({ id: uid(), name, amount: 0, on: true, color }, o, key));
      const row = box.lastElementChild;
      if (name) ($('.e-amount', row) || $('.e-name', row)).focus();
      else openEmoji(row, key, () => { $('.e-name', row).focus(); onChange(); }); // « Autre » : on choisit d’abord l’emoji
      refresh();
      onChange();
    });
    box.addEventListener('click', (e) => {
      const emoBtn = e.target.closest('.e-emo');
      if (emoBtn && !dragged) { openEmoji(emoBtn.closest('.erow'), key, onChange); return; }
      const del = e.target.closest('.e-del');
      if (!del) return;
      del.closest('.erow').remove();
      refresh();
      onChange();
    });
    box.addEventListener('change', (e) => {
      if (e.target.classList.contains('e-on')) e.target.closest('.erow').classList.toggle('off', !e.target.checked);
      if (e.target.classList.contains('e-per')) {
        const money = e.target.nextElementSibling;
        money.hidden = e.target.value === 'auto';
        if (!money.hidden) $('input', money).focus();
      }
      if (e.target.classList.contains('e-name')) refresh();
      onChange();
    });
    box.addEventListener('input', (e) => {
      const row = e.target.closest('.erow');
      // Tant qu’aucun emoji n’a été choisi, il suit le nom (« Électricité » → ⚡).
      if (e.target.classList.contains('e-name') && !row.dataset.emoji) $('.e-emo', row).textContent = emojiOf({ name: e.target.value }, key);
      onChange();
    });

    // Appui long sur une ligne (ailleurs que dans un champ), puis glisser : change l’ordre.
    let press = null, drag = null, dragged = false;
    const cancelPress = () => { if (press) clearTimeout(press.timer); press = null; };
    box.addEventListener('pointerdown', (e) => {
      dragged = false;
      const row = e.target.closest('.erow');
      if (!row || e.button > 0 || e.target.closest('input, select, .e-del')) return;
      const id = e.pointerId;
      press = {
        x: e.clientX,
        y: e.clientY,
        timer: setTimeout(() => {
          press = null;
          drag = row;
          row.classList.add('dragging');
          try { box.setPointerCapture(id); } catch { /* pointeur déjà relâché */ }
        }, 350),
      };
    });
    box.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
      if (!drag) return;
      const next = $$('.erow', box).find((r) => r !== drag && e.clientY < r.getBoundingClientRect().top + r.offsetHeight / 2);
      if (next ? drag.nextElementSibling !== next : box.lastElementChild !== drag) box.insertBefore(drag, next || null);
    });
    const drop = () => {
      cancelPress();
      if (!drag) return;
      drag.classList.remove('dragging');
      drag = null;
      dragged = true; // pas d’ouverture du choix d’emoji au relâchement
      onChange();
    };
    box.addEventListener('pointerup', drop);
    box.addEventListener('pointercancel', drop);
    box.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false }); // pas de défilement pendant le déplacement
    box.addEventListener('contextmenu', (e) => { if (e.target.closest('.e-emo')) e.preventDefault(); });
    refresh();
  }

  /** Lit un éditeur ; renvoie { items } ou { error }. */
  function readEditor(root, key, { toggle = false, min = 0, what }) {
    const items = [];
    for (const row of $$(`[data-editor="${key}"] .erow`, root)) {
      if (toggle && !$('.e-on', row).checked) continue;
      const name = $('.e-name', row).value.trim();
      const raw = $('.e-amount', row)?.value.trim() ?? '';
      if (!name) {
        if (!raw) continue; // ligne vide : ignorée
        return { error: `Une ligne de « ${what} » n’a pas de nom.` };
      }
      const amount = raw === '' ? 0 : parseAmount(raw);
      if (Number.isNaN(amount)) return { error: `Montant invalide pour « ${name} » (exemple : 12,50).` };
      const dayEl = $('.e-day-in', row);
      const rawDay = dayEl ? dayEl.value.trim() : '';
      const day = rawDay ? Number(rawDay) : null;
      if (rawDay && !(Number.isInteger(day) && day >= 1 && day <= 31)) return { error: `Jour invalide pour « ${name} » : mettez un nombre entre 1 et 31.` };
      const item = { id: row.dataset.id, name: name.slice(0, 40), amount, day, color: row.dataset.color, emoji: row.dataset.emoji || null };
      const perEl = $('.e-per', row);
      if (perEl) {
        item.per = perEl.value === 'auto' ? null : perEl.value;
        item.amount = null;
        if (item.per) {
          const v = parseAmount($('.e-cat-amt', row).value.trim());
          if (Number.isNaN(v) || v === 0) return { error: `Indiquez le montant pour « ${name} » (exemple : 45), ou choisissez « L’app propose ».` };
          item.amount = v;
        }
      }
      items.push(item);
    }
    if (items.length < min) return { error: `Gardez au moins une ligne dans « ${what} ».` };
    return { items };
  }

  function sumEditor(root, key) {
    let total = 0;
    for (const row of $$(`[data-editor="${key}"] .erow`, root)) {
      const v = parseAmount($('.e-amount', row)?.value.trim() || '0');
      if (!Number.isNaN(v)) total += v;
    }
    return total;
  }

  /* ---------- Premier lancement : parcours guidé ---------- */

  function newDraft() {
    return {
      currency: 'EUR',
      incomes: [{ id: uid(), name: 'Salaire', amount: 0, day: null }],
      fixed: [{ id: uid(), name: 'Loyer', amount: 0, day: null }],
      categories: SUGGEST.cat.map((name, i) => ({ id: uid(), name, color: PALETTE[i % PALETTE.length], on: DEFAULT_CATS.includes(name), per: null, amount: null })),
      plan: 'equilibre',
      alloc: null,
      livret: 0,
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

  function setupAllocCtx() {
    const d = ui.draft;
    return { income: sum(d.incomes, (i) => i.amount), fixed: sum(d.fixed, (i) => i.amount), cats: d.categories.filter((c) => c.on) };
  }

  function renderSetup() {
    const d = ui.draft;
    const s = ui.step;
    const o = { currency: d.currency };
    let title, intro, body = '', next = 'Continuer';

    if (s === 0) {
      title = 'Bienvenue';
      intro = 'Chaque mois, l’app vous dit combien prévoir pour les courses, les loisirs… et combien mettre de côté. Elle suit aussi votre épargne.';
      body = `
        <ol class="howto">
          <li><b>Ce que vous recevez</b> : salaire, chômage, aides…</li>
          <li><b>Ce qui part tout seul</b> : loyer, factures, abonnements…</li>
          <li><b>Vos dépenses de tous les jours</b> : courses, tabac, loisirs…</li>
          <li><b>Votre plan</b> : la répartition proposée par l’app</li>
        </ol>
        <label class="field"><span>Devise</span><select id="d-currency">${currencyOptions(d.currency)}</select></label>`;
      next = 'Commencer';
    } else if (s === 1) {
      title = 'Ce que vous recevez chaque mois';
      intro = 'Salaire, allocation chômage, aides (APL, prime d’activité…). Mettez le montant habituel : si ça change d’un mois à l’autre, vous le corrigerez au début de chaque mois.';
      body = `${editorHTML('income', d.incomes, { ...o, ...DAY.income, placeholder: 'Nom de la rentrée' })}
        <p class="live" id="live"></p>`;
    } else if (s === 2) {
      title = 'Ce qui part tout seul chaque mois';
      intro = 'Loyer, factures, abonnements, assurances, crédit… Indiquez le jour du prélèvement : l’app en a besoin pour calculer combien vous pouvez dépenser par jour.';
      body = `${editorHTML('fixed', d.fixed, { ...o, ...DAY.fixed, placeholder: 'Nom de la dépense' })}
        <p class="live" id="live"></p>`;
    } else if (s === 3) {
      title = 'Vos dépenses de tous les jours';
      intro = 'Cochez ce pour quoi vous voulez un budget : courses, tabac, loisirs… Vous connaissez déjà le montant (par exemple 40 € par semaine de courses) ? Indiquez-le. Sinon, l’app propose un montant.';
      body = `${editorHTML('cat', d.categories, { ...o, toggle: true, noAmount: true, catAmount: true })}
        <p class="live" id="live"></p>`;
    } else {
      title = 'Votre plan';
      intro = 'Voici comment répartir ce qui reste après les dépenses fixes. Choisissez un plan, puis ajustez si besoin.';
      body = `
        ${allocHTML(setupAllocCtx(), d.alloc || proposePlan(d.plan, setupAllocCtx()), d.plan)}
        <label class="field"><span>Sur votre livret d’épargne aujourd’hui (facultatif)</span>
          <span class="money"><input id="d-livret" inputmode="decimal" placeholder="0" value="${centsToInput(d.livret)}" autocomplete="off"><span class="cur">${esc(currencySymbol())}</span></span></label>`;
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
    if (s === 1) bindEditor(root, 'income', { ...o, ...DAY.income, suggestions: SUGGEST.income, placeholder: 'Nom de la rentrée' }, live);
    if (s === 2) bindEditor(root, 'fixed', { ...o, ...DAY.fixed, suggestions: SUGGEST.fixed, placeholder: 'Nom de la dépense' }, live);
    if (s === 3) bindEditor(root, 'cat', { ...o, toggle: true, noAmount: true, catAmount: true, withColor: true, placeholder: 'Nom du poste' }, live);
    if (s === 4) ui.alloc = bindAlloc(root, setupAllocCtx());
    if (s > 0 && s < 4) live();

    $('#setup-next').addEventListener('click', () => {
      const err = readStep();
      if (err) { $('#setup-error').textContent = err; return; }
      if (ui.step < STEP_COUNT) goStep(1);
      else finishSetup();
    });
    if (s > 0) {
      $('#setup-back').addEventListener('click', () => {
        readStep(); // garde ce qui est valide, sans bloquer le retour
        goStep(-1);
      });
    }
    if (s === 0) $('#setup-import').addEventListener('click', () => $('#import-file').click());
  }

  function updateSetupLive(root) {
    const d = ui.draft;
    const el = $('#live', root);
    const inc = ui.step === 1 ? sumEditor(root, 'income') : sum(d.incomes, (i) => i.amount);
    const fix = ui.step === 2 ? sumEditor(root, 'fixed') : sum(d.fixed, (i) => i.amount);
    if (ui.step === 1) {
      el.innerHTML = `Total : <b>${money(inc)}</b> par mois`;
    } else if (ui.step === 2) {
      el.innerHTML = `Total : <b>${money(fix)}</b> par mois.<br>Une fois ces dépenses payées, il reste <b class="${inc - fix < 0 ? 'neg' : ''}">${money(inc - fix)}</b>.`;
    } else if (ui.step === 3) {
      const n = $$('[data-editor="cat"] .e-on', root).filter((c) => c.checked).length;
      el.innerHTML = `${plural(n, 'poste')} ${n > 1 ? 'choisis' : 'choisi'}. Il y a <b>${money(inc - fix)}</b> à répartir entre eux, l’épargne et une marge pour les imprévus.`;
    }
  }

  /** Lit l’étape affichée dans le brouillon. Renvoie un message d’erreur ou ''. */
  function readStep() {
    const d = ui.draft;
    const root = $('#setup');
    if (ui.step === 0) {
      d.currency = $('#d-currency', root).value;
    } else if (ui.step === 1 || ui.step === 2) {
      d.alloc = null; // les montants changent : nouvelle proposition à l’étape du plan
      const key = ui.step === 1 ? 'income' : 'fixed';
      const r = readEditor(root, key, { what: ui.step === 1 ? 'Ce que vous recevez' : 'Ce qui part tout seul' });
      if (r.error) return r.error;
      d[ui.step === 1 ? 'incomes' : 'fixed'] = r.items.map(({ id, name, amount, day, emoji }) => ({ id, name, amount, day, emoji }));
    } else if (ui.step === 3) {
      d.alloc = null;
      const r = readEditor(root, 'cat', { toggle: true, min: 1, what: 'Vos dépenses de tous les jours' });
      if (r.error) return r.error;
      const picked = new Map(r.items.map((c) => [c.id, c]));
      d.categories = $$('[data-editor="cat"] .erow', root)
        .map((row, i) => ({
          id: row.dataset.id,
          name: $('.e-name', row).value.trim().slice(0, 40),
          color: row.dataset.color || PALETTE[i % PALETTE.length],
          on: $('.e-on', row).checked,
          emoji: row.dataset.emoji || null,
          per: picked.has(row.dataset.id) ? picked.get(row.dataset.id).per : null,
          amount: picked.has(row.dataset.id) ? picked.get(row.dataset.id).amount : null,
        }))
        .filter((c) => c.name);
    } else {
      const r = ui.alloc.read();
      d.plan = r.plan;
      d.alloc = r; // garde la saisie si on revient en arrière
      if (r.error) return r.error;
      const livret = readMoneyInput($('#d-livret', root));
      if (Number.isNaN(livret)) return 'Montant du livret invalide.';
      d.livret = livret;
    }
    return '';
  }

  function finishSetup() {
    const d = ui.draft;
    const cm = currentMonth();
    const cats = d.categories.filter((c) => c.on).map(({ id, name, color, per, amount, emoji }) => ({ id, name, color, per, amount, emoji }));
    state = validate({
      version: SCHEMA_VERSION,
      currency: d.currency,
      incomes: d.incomes,
      fixed: d.fixed,
      categories: cats,
      plan: d.plan,
      months: {
        [cm]: {
          incomes: Object.fromEntries(d.incomes.map((i) => [i.id, i.amount])),
          fixed: Object.fromEntries(d.fixed.map((i) => [i.id, i.amount])),
          plan: d.plan,
          save: d.alloc.save,
          budgets: Object.fromEntries(cats.map((c) => [c.id, d.alloc.budgets.get(c.id) || 0])),
        },
      },
      bank: null,
      savings: d.livret ? [{ date: todayISO(), amount: d.livret }] : [],
      createdAt: todayISO(),
      lastBackup: null,
    });
    if (!save()) return;
    ui.draft = null;
    requestPersistence();
    start();
    toast('Votre budget est prêt');
  }

  /* ---------- Navigation ---------- */

  const TITLES = { savings: 'Épargne', settings: 'Réglages', edit: 'Budget du mois' };

  /** Enregistre tout de suite une modification des Réglages encore en attente. */
  let flushSettings = () => {};

  function show(view) {
    flushSettings();
    ui.view = view;
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view || (view === 'edit' && t.dataset.view === 'month')));
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
    const hasNav = ui.view === 'month';
    $('.topbar').classList.toggle('no-nav', !hasNav);
    $('#title').textContent = hasNav ? monthLabel(ui.month) : ui.view === 'edit' ? `Budget ${ofMonth(ui.month)}` : TITLES[ui.view];
    ({ month: renderMonth, savings: renderSavings, settings: renderSettings, edit: renderEdit })[ui.view]();
  }

  function bindGo(root) {
    $$('[data-go]', root).forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.go === 'edit') { ui.editStep = 1; ui.editDraft = null; }
      show(b.dataset.go);
    }));
  }

  /* ---------- Mois ---------- */

  /** Ligne « nom + petite précision » à gauche, montant à droite. */
  const lineHTML = (label, detail, amount, cls = '') => `
    <div class="line${cls ? ` ${cls}` : ''}"><span class="lbl">${label}${detail ? `<small>${detail}</small>` : ''}</span><span class="num">${amount}</span></div>`;

  /** Ligne à cocher quand le prélèvement (ou le virement) est passé. */
  function dueHTML(month, id, label, detail, amount, cls = '') {
    const done = isDone(month, id);
    return `
      <button type="button" class="line due${cls ? ` ${cls}` : ''}${done ? ' done' : ''}" data-due="${esc(id)}" aria-pressed="${done}">
        <span class="due-left"><span class="tick" aria-hidden="true"></span><span class="lbl"><span>${label}</span><small>${detail}</small></span></span>
        <span class="num">−${money(amount)}</span>
      </button>`;
  }

  /** Sur votre compte → ce qui doit encore partir → combien dépenser par jour. */
  function dailyHTML(b) {
    const a = dailyAllowance(b);
    if (!a) {
      const old = state.bank && state.bank.date.slice(0, 7) < b.month;
      return `
        <section class="account empty">
          <p class="account-label">Sur votre compte aujourd’hui</p>
          <p class="note">${old ? 'Votre dernier solde date du mois dernier. ' : ''}Recopiez le montant affiché par l’app de votre banque : l’app calcule combien vous pouvez dépenser par jour.</p>
          <button type="button" class="btn primary" data-bank>Entrer mon solde</button>
        </section>`;
    }
    const stale = daysSince(a.bank.date) > 0;
    const dim = daysInMonth(b.month);
    const dayOf = (x) => Math.min(x.item.day, dim);
    return `
      <section class="account">
        <p class="account-label">Sur votre compte ${stale ? `le ${esc(shortDate(a.bank.date))}` : 'aujourd’hui'}</p>
        <p class="account-amount num${a.bank.amount < 0 ? ' neg' : ''}">${money(a.bank.amount)}</p>
        ${stale
          ? `<p class="account-stale">Ce montant n’est plus à jour.</p><button type="button" class="btn primary" data-bank>Mettre à jour</button>`
          : '<button type="button" class="link" data-bank>Modifier</button>'}
      </section>

      <section class="block">
        <h2 class="sec">Ce qui doit encore partir</h2>
        ${a.toCome.length || b.save ? '<p class="note">Touchez une ligne quand c’est déjà passé sur votre compte : elle ne sera plus retirée.</p>' : ''}
        ${b.save ? dueHTML(b.month, 'save', '<span class="emo" aria-hidden="true">🐷</span> Virement vers le livret', b.saveDone ? 'virement fait' : 'à faire : touchez quand c’est fait', b.save, 'save') : ''}
        ${a.toCome.map((x) => dueHTML(b.month, x.item.id, `${emo(x.item, 'fixed')} ${esc(x.item.name)}`,
          isDone(b.month, x.item.id) ? 'déjà passé' : x.item.day ? `prélevé le ${dayOf(x)}` : 'jour non indiqué : compté par prudence', x.amount)).join('')}
        ${!a.toCome.length && !b.save ? '<p class="note">Plus rien à payer d’ici la fin du mois.</p>' : ''}
        ${lineHTML('Reste pour finir le mois', '', money(a.left), `total${a.left < 0 ? ' neg' : ''}`)}
      </section>

      <section class="perday${a.left <= 0 ? ' short' : ''}">
        <p class="perday-label">Vous pouvez dépenser</p>
        <p class="perday-amount num">${money(a.left > 0 ? a.perDay : 0)}<span> par jour</span></p>
        <p class="perday-sub">${a.left > 0
          ? `jusqu’au ${dim} ${esc(monthName(b.month))} (${plural(a.daysLeft, 'jour')})`
          : `Il manque ${money(-a.left)} pour payer ce qui doit encore partir.`}</p>
        <p class="perday-why">C’est le chiffre à suivre au quotidien : il part de l’argent qui est vraiment sur votre compte. Courses, tabac, loisirs… se paient avec.</p>
      </section>
      ${a.incomesToCome.length ? `
        <p class="note">Pas encore compté, car pas encore arrivé : ${a.incomesToCome.map((x) => `${esc(emojiOf(x.item, 'income'))} ${esc(x.item.name)} +${money(x.amount)} le ${dayOf(x)}`).join(', ')}.</p>` : ''}`;
  }

  function renderMonth() {
    const m = ui.month;
    const cm = currentMonth();
    const b = budgetFor(m);
    const isCur = m === cm;

    if (!b.confirmed && m < cm) {
      $('#view-month').innerHTML = `<p class="empty">Pas de budget enregistré pour ${esc(monthName(m))}.</p>`;
      return;
    }

    const cats = state.categories.map((c) => {
      const amount = b.budgets.get(c.id) || 0;
      const detail = c.per === 'week' ? esc(knownLabel(c)) : c.per || !amount ? '' : `environ ${roundMoney(amount * 12 / 52)} par semaine`;
      return lineHTML(`<span>${emo(c, 'cat')} ${esc(c.name)}</span>`, detail, money(amount));
    }).join('');

    $('#view-month').innerHTML = `
      ${!b.confirmed && m >= cm ? `
        <div class="tip warn top-tip">
          <p>${isCur ? 'Nouveau mois' : capitalize(monthName(m))} : vérifiez ce que vous allez recevoir, puis validez votre budget.</p>
          <button type="button" class="link inline" data-go="edit">Vérifier</button>
        </div>` : ''}

      ${isCur ? dailyHTML(b) : ''}

      ${isCur ? backupTipHTML() : ''}

      <section class="block">
        <h2 class="sec">Budget ${esc(ofMonth(m))}${b.confirmed ? '' : ' <span class="muted">proposé</span>'}</h2>
        <p class="note">Votre plan pour le mois : combien prévoir pour chaque chose. ${isCur ? 'Pour savoir où vous en êtes aujourd’hui, regardez le montant « par jour » plus haut.' : ''}</p>
        ${lineHTML('Vous recevez', '', `+${money(b.income)}`, 'pos-line')}
        ${lineHTML('Loyer, factures, abonnements', '', `−${money(b.fixedTotal)}`)}
        ${lineHTML('Reste à répartir', '', money(b.free), `total${b.free < 0 ? ' neg' : ''}`)}

        <h3 class="sub-sec">Mettre de côté</h3>
        ${lineHTML('<span><span class="emo" aria-hidden="true">🐷</span> Épargne</span>', 'virement vers le livret', money(b.save), 'save-line')}
        ${isCur && b.save ? `
          <button type="button" class="save-done${b.saveDone ? ' on' : ''}" data-save-done aria-pressed="${b.saveDone}">
            <span class="box" aria-hidden="true"></span>${b.saveDone ? 'Virement fait' : 'J’ai fait le virement'}
          </button>` : ''}

        ${state.categories.length ? `<h3 class="sub-sec">Dépenses de tous les jours</h3>${cats}` : ''}
        ${lineHTML('Marge pour les imprévus', 'ce qui n’est pas réparti', money(b.margin), b.margin < 0 ? 'neg' : '')}
        ${b.margin < 0 ? '<p class="msg warn">Vous prévoyez plus que ce qu’il y a à répartir. Baissez un montant.</p>' : ''}
        ${m >= cm ? `<button type="button" class="btn" data-go="edit">${b.confirmed ? 'Modifier le budget' : 'Vérifier et valider'}</button>` : ''}
      </section>`;

    const view = $('#view-month');
    bindGo(view);
    $$('[data-bank]', view).forEach((el) => el.addEventListener('click', openBank));
    $$('[data-backup]', view).forEach((el) => el.addEventListener('click', exportData));
    $$('[data-save-done], [data-due]', view).forEach((el) => el.addEventListener('click', () => {
      const id = el.dataset.due || 'save';
      toggleDone(m, id);
      if (isDone(m, id)) toast(id === 'save' ? 'Virement d’épargne fait' : 'Noté : déjà passé');
      const y = window.scrollY;
      renderMonth();
      window.scrollTo(0, y);
    }));
  }

  /* ---------- Budget du mois : montants reçus / prélevés, puis répartition ---------- */

  function renderEdit() {
    const m = ui.month;
    const view = $('#view-edit');
    const b = budgetFor(m);
    if (!ui.editDraft) {
      ui.editDraft = {
        incomes: new Map(b.incomes.map((x) => [x.item.id, x.amount])),
        fixed: new Map(b.fixed.map((x) => [x.item.id, x.amount])),
        plan: b.plan,
        alloc: b.confirmed ? { save: b.save, budgets: b.budgets } : null,
      };
    }
    const d = ui.editDraft;
    const field = (kind, item) => `
      <label class="alloc-row"><span class="alloc-name"><span>${emo(item, kind === 'income' ? 'income' : 'fixed')} ${esc(item.name)}</span>${item.day ? `<small>${kind === 'income' ? 'arrive' : 'prélevé'} le ${item.day}</small>` : ''}</span>
        <span class="money"><input data-kind="${kind}" data-id="${esc(item.id)}" inputmode="decimal" placeholder="0" value="${centsToInput(d[kind === 'income' ? 'incomes' : 'fixed'].get(item.id) || 0)}" autocomplete="off" aria-label="${esc(item.name)}"><span class="cur">${esc(currencySymbol())}</span></span></label>`;

    if (ui.editStep === 1) {
      view.innerHTML = `
        <section class="block">
          <p class="note">Vérifiez les montants ${esc(ofMonth(m))}. Mettez 0 si quelque chose ne tombe pas ce mois-ci.</p>
          <h3 class="alloc-sec">Ce que vous recevez</h3>
          ${state.incomes.map((i) => field('income', i)).join('') || '<p class="note">Aucune rentrée : ajoutez-en dans Réglages.</p>'}
          <p class="live" id="edit-inc"></p>
          <h3 class="alloc-sec">Ce qui part tout seul</h3>
          ${state.fixed.map((i) => field('fixed', i)).join('') || '<p class="note">Aucune dépense fixe.</p>'}
          <p class="live" id="edit-free"></p>
          <p class="note">Une rentrée ou une dépense nouvelle ? Ajoutez-la dans Réglages.</p>
          <p class="error" id="edit-error" role="alert"></p>
          <button type="button" class="btn primary" id="edit-next">Continuer</button>
          <button type="button" class="btn ghost" id="edit-cancel">Annuler</button>
        </section>`;
      const read = () => {
        let bad = false;
        for (const el of $$('[data-kind]', view)) {
          const v = readMoneyInput(el);
          if (Number.isNaN(v)) { bad = true; continue; }
          d[el.dataset.kind === 'income' ? 'incomes' : 'fixed'].set(el.dataset.id, v);
        }
        return bad;
      };
      const live = () => {
        read();
        const inc = sum([...d.incomes.values()], (x) => x);
        const fix = sum([...d.fixed.values()], (x) => x);
        $('#edit-inc', view).innerHTML = `Total reçu : <b>${money(inc)}</b>`;
        $('#edit-free', view).innerHTML = `Total prélevé : <b>${money(fix)}</b>. Il reste <b class="${inc - fix < 0 ? 'neg' : ''}">${money(inc - fix)}</b> à répartir.`;
      };
      view.addEventListener('input', live);
      live();
      $('#edit-next', view).addEventListener('click', () => {
        if (read()) { $('#edit-error', view).textContent = 'Un montant est invalide (exemple : 1200 ou 45,90).'; return; }
        d.alloc = null; // les montants ont pu changer : nouvelle proposition
        ui.editStep = 2;
        renderEdit();
        window.scrollTo(0, 0);
      });
    } else {
      const ctx = {
        income: sum([...d.incomes.values()], (x) => x),
        fixed: sum([...d.fixed.values()], (x) => x),
        cats: state.categories,
      };
      const values = d.alloc || proposePlan(d.plan, ctx);
      view.innerHTML = `
        <section class="block">
          ${allocHTML(ctx, values, d.plan)}
          <p class="error" id="edit-error" role="alert"></p>
          <button type="button" class="btn primary" id="edit-save">Valider mon budget</button>
          <button type="button" class="btn ghost" id="edit-back">Retour</button>
        </section>`;
      const alloc = bindAlloc(view, ctx);
      $('#edit-back', view).addEventListener('click', () => {
        const r = alloc.read();
        d.plan = r.plan;
        ui.editStep = 1;
        renderEdit();
      });
      $('#edit-save', view).addEventListener('click', () => {
        const r = alloc.read();
        if (r.error) { $('#edit-error', view).textContent = r.error; return; }
        state.months[m] = {
          incomes: Object.fromEntries(d.incomes),
          fixed: Object.fromEntries(d.fixed),
          plan: r.plan,
          save: r.save,
          budgets: Object.fromEntries(r.budgets),
        };
        state.plan = r.plan;
        if (!save()) return;
        ui.editDraft = null;
        toast(`Budget ${ofMonth(m)} validé`);
        show('month');
      });
    }
    $('#edit-cancel', view)?.addEventListener('click', () => { ui.editDraft = null; show('month'); });
  }

  /* ---------- Épargne ---------- */

  function savingsChartHTML(points) {
    if (points.length < 2) return '<p class="note">La courbe apparaîtra dès que vous aurez mis à jour le solde du livret une deuxième fois.</p>';
    const t = (iso) => new Date(iso).getTime();
    const t0 = t(points[0].date);
    const span = Math.max(1, t(points[points.length - 1].date) - t0);
    const values = points.map((p) => p.amount);
    const W = 300, H = 130, L = 4, R = 4, T = 18, B = 20;
    const min = Math.min(0, ...values);
    const max = Math.max(1, ...values) * 1.1;
    const x = (p) => L + ((t(p.date) - t0) / span) * (W - L - R);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const line = points.map((p) => `${fx(x(p))},${fx(y(p.amount))}`).join(' ');
    const first = points[0];
    const last = points[points.length - 1];
    return `
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Épargne de ${esc(money(first.amount))} le ${esc(shortDate(first.date))} à ${esc(money(last.amount))} le ${esc(shortDate(last.date))}">
        <line class="ch-axis" x1="${L}" y1="${fx(y(min))}" x2="${W - R}" y2="${fx(y(min))}"/>
        <polygon class="ch-save-area" points="${fx(x(first))},${fx(y(min))} ${line} ${fx(x(last))},${fx(y(min))}"/>
        <polyline class="ch-save-line" points="${line}"/>
        ${points.map((p) => `<circle class="ch-save-dot" cx="${fx(x(p))}" cy="${fx(y(p.amount))}" r="3"/>`).join('')}
        <text class="ch-value" x="${fx(x(last))}" y="${fx(y(last.amount) - 9)}" text-anchor="end">${esc(roundMoney(last.amount))}</text>
        <text x="${L}" y="${H - 4}">${esc(shortDate(first.date))}</text>
        <text x="${W - R}" y="${H - 4}" text-anchor="end">${esc(shortDate(last.date))}</text>
      </svg>`;
  }

  function renderSavings() {
    const pts = state.savings;
    const last = pts[pts.length - 1];
    const first = pts[0];
    const b = budgetFor(currentMonth());
    const diff = last && first !== last ? last.amount - first.amount : 0;

    $('#view-savings').innerHTML = `
      <section class="hero">
        <p class="eyebrow">Sur votre livret</p>
        <p class="big num">${last ? money(last.amount) : '—'}</p>
        <p class="sub">${last
          ? `${daysSince(last.date) === 0 ? 'aujourd’hui' : `le ${esc(shortDate(last.date))}`}${diff ? ` · <b class="${diff < 0 ? 'neg' : 'pos'}">${diff > 0 ? '+' : '−'}${money(Math.abs(diff))}</b> depuis le ${esc(shortDate(first.date))}` : ''}`
          : 'Recopiez le solde affiché pour votre livret dans l’app de votre banque.'}</p>
        <button type="button" class="btn primary" data-livret>${last ? 'Mettre à jour le solde' : 'Entrer le solde du livret'}</button>
      </section>

      <section class="block">
        <h2 class="sec">Évolution</h2>
        ${savingsChartHTML(pts)}
      </section>

      <section class="block">
        <h2 class="sec">Ce mois-ci</h2>
        <div class="line"><span>Épargne prévue en ${esc(monthName(b.month))}</span><span class="num">${money(b.save)}</span></div>
        <p class="note">${b.save ? (b.saveDone ? 'Virement fait.' : 'Pensez au virement vers le livret, puis cochez-le dans l’onglet Mois.') : 'Aucune épargne prévue ce mois-ci.'}</p>
      </section>

      ${pts.length ? `
        <section class="block">
          <h2 class="sec">Vos relevés</h2>
          ${pts.slice().reverse().map((p, i, arr) => {
            const before = arr[i + 1];
            const d = before ? p.amount - before.amount : 0;
            return `<button type="button" class="line pt-row" data-date="${esc(p.date)}">
              <span>${esc(capitalize(shortDate(p.date)))}${d ? ` <small class="${d < 0 ? 'neg' : 'pos'}">${d > 0 ? '+' : '−'}${money(Math.abs(d))}</small>` : ''}</span>
              <span class="num">${money(p.amount)}</span></button>`;
          }).join('')}
          <p class="note">Touchez un relevé pour le supprimer.</p>
        </section>` : ''}`;

    const view = $('#view-savings');
    $('[data-livret]', view).addEventListener('click', openLivret);
    $$('.pt-row', view).forEach((row) => row.addEventListener('click', () => {
      if (!confirm(`Supprimer le relevé du ${shortDate(row.dataset.date)} ?`)) return;
      state.savings = state.savings.filter((p) => p.date !== row.dataset.date);
      save();
      renderSavings();
    }));
  }

  /* ---------- Fenêtre de saisie d’un montant (solde du compte, du livret) ---------- */

  let dlgSave = null;

  function openAmount({ title, text, value, negative = false, onSave }) {
    const dlg = $('#dlg');
    if (typeof dlg.showModal !== 'function') {
      // Navigateur ancien : saisie simple.
      const v = prompt(`${title}\n${text}`, value == null ? '' : centsToInput(value));
      if (v === null) return;
      const neg = /^[−-]/.test(v.trim());
      const amount = parseAmount(v.trim().replace(/^[−-]/, ''));
      if (Number.isNaN(amount)) { alert('Montant invalide.'); return; }
      onSave(neg ? -amount : amount);
      return;
    }
    dlgSave = onSave;
    $('#dlg-title').textContent = title;
    $('#dlg-text').textContent = text;
    $('#dlg-amount').value = value == null ? '' : centsToInput(Math.abs(value));
    $('#dlg-neg').checked = negative && value < 0;
    $('#dlg-neg-wrap').hidden = !negative;
    $('#dlg .cur').textContent = currencySymbol();
    $('#dlg-error').textContent = '';
    dlg.showModal();
  }

  function openBank() {
    openAmount({
      title: 'Solde de votre compte',
      text: 'Le montant affiché maintenant sur votre compte courant, dans l’app de votre banque.',
      value: state.bank ? state.bank.amount : null,
      negative: true,
      onSave(amount) {
        state.bank = { amount, date: todayISO() };
        save();
        toast('Solde enregistré');
        render();
      },
    });
  }

  function openLivret() {
    const last = state.savings[state.savings.length - 1];
    openAmount({
      title: 'Solde du livret',
      text: 'Le montant affiché maintenant sur votre livret d’épargne, dans l’app de votre banque.',
      value: last ? last.amount : null,
      onSave(amount) {
        const day = todayISO();
        state.savings = state.savings.filter((p) => p.date !== day).concat({ date: day, amount }).sort((a, b) => a.date.localeCompare(b.date));
        save();
        toast('Solde du livret enregistré');
        render();
      },
    });
  }

  /* ---------- Choix d’un emoji ---------- */

  let emoPick = null;

  /** Ouvre le choix d’emoji pour une ligne d’éditeur ; `done` est appelé après un choix. */
  function openEmoji(row, kind, done) {
    const dlg = $('#emo');
    const apply = (value) => {
      if (value) row.dataset.emoji = value; else delete row.dataset.emoji;
      $('.e-emo', row).textContent = emojiOf({ emoji: value, name: $('.e-name', row).value }, kind);
      closeDialog(dlg);
      done();
    };
    if (typeof dlg.showModal !== 'function') {
      const v = prompt('Emoji (laisser vide pour automatique)', row.dataset.emoji || '');
      if (v !== null) apply(firstGrapheme(v));
      return;
    }
    emoPick = apply;
    const current = $('.e-emo', row).textContent;
    $('#emo-grid').innerHTML = EMOJI_CHOICES.map((e) => `<button type="button" data-e="${esc(e)}" class="${e === current ? 'on' : ''}">${e}</button>`).join('');
    $('#emo-input').value = '';
    dlg.showModal();
  }

  function firstGrapheme(v) {
    const t = String(v).trim();
    if (!t) return null;
    if (window.Intl && Intl.Segmenter) return [...new Intl.Segmenter('fr', { granularity: 'grapheme' }).segment(t)][0].segment;
    return Array.from(t)[0];
  }

  function bindEmoji() {
    const dlg = $('#emo');
    $('#emo-grid').addEventListener('click', (e) => {
      const b = e.target.closest('[data-e]');
      if (b && emoPick) emoPick(b.dataset.e);
    });
    $('#emo-use').addEventListener('click', () => {
      const v = firstGrapheme($('#emo-input').value);
      if (v && emoPick) emoPick(v);
    });
    $('#emo-auto').addEventListener('click', () => { if (emoPick) emoPick(null); });
    $('#emo-cancel').addEventListener('click', () => closeDialog(dlg));
  }

  /** Referme la fenêtre en la faisant redescendre. */
  function closeDialog(dlg = $('#dlg')) {
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
    const place = () => {
      const hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      for (const dlg of $$('dialog')) dlg.style.setProperty('--kb', `${hidden}px`);
    };
    vv.addEventListener('resize', place);
    vv.addEventListener('scroll', place);
  }

  function bindDialog() {
    followKeyboard();
    bindEmoji();
    for (const d of $$('dialog')) {
      d.addEventListener('cancel', (e) => { e.preventDefault(); closeDialog(d); }); // touche Échap
      d.addEventListener('click', (e) => { // toucher en dehors de la fenêtre
        const r = d.getBoundingClientRect();
        if (e.target === d && (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right)) closeDialog(d);
      });
    }
    $('#dlg-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if ((e.submitter && e.submitter.value === 'cancel') || !dlgSave) { closeDialog(); return; }
      const typed = $('#dlg-amount').value.trim();
      const raw = typed.replace(/^[−-]/, '');
      if (!raw) { $('#dlg-error').textContent = 'Indiquez un montant (exemple : 850,40).'; return; }
      const amount = parseAmount(raw);
      if (Number.isNaN(amount)) { $('#dlg-error').textContent = 'Montant invalide (exemple : 850,40).'; return; }
      const negative = $('#dlg-neg').checked || /^[−-]/.test(typed);
      const done = dlgSave;
      dlgSave = null;
      closeDialog();
      done(negative ? -amount : amount);
    });
  }

  /* ---------- Réglages ---------- */

  function renderSettings() {
    const o = { currency: state.currency };
    $('#view-settings').innerHTML = `
      <section class="block">
        <h2 class="sec">Ce que vous recevez <span class="muted" id="t-income"></span></h2>
        <p class="note">Les montants habituels. Touchez un emoji pour le changer ; appuyez longuement dessus puis glissez pour changer l’ordre.</p>
        ${editorHTML('income', state.incomes, { ...o, ...DAY.income, placeholder: 'Nom de la rentrée' })}
      </section>

      <section class="block">
        <h2 class="sec">Ce qui part tout seul <span class="muted" id="t-fixed"></span></h2>
        <p class="note">Loyer, factures, abonnements… avec le jour du prélèvement.</p>
        ${editorHTML('fixed', state.fixed, { ...o, ...DAY.fixed, placeholder: 'Nom de la dépense' })}
      </section>

      <section class="block">
        <h2 class="sec">Dépenses de tous les jours</h2>
        <p class="note">Courses, tabac, loisirs… Indiquez le montant si vous le connaissez, sinon l’app le propose chaque mois.</p>
        ${editorHTML('cat', state.categories, { ...o, noAmount: true, catAmount: true, placeholder: 'Nom du poste' })}
      </section>

      <section class="block">
        <label class="field"><span>Devise</span><select id="set-currency">${currencyOptions(state.currency)}</select></label>
      </section>

      <p id="set-error" class="error" role="alert"></p>
      <p class="saved-note" id="set-saved" aria-live="polite">Les changements sont enregistrés automatiquement.</p>

      <section class="block" style="margin-top:40px">
        <h2 class="sec">Sauvegarde</h2>
        <p class="note">Vos données sont uniquement sur ce téléphone. Exportez de temps en temps un fichier (dans Fichiers ou iCloud Drive) pour ne rien perdre et pour changer d’appareil.</p>
        <p class="note" id="backup-note">${backupNoteHTML()}</p>
        <div class="row-btns">
          <button type="button" class="btn" id="btn-export">Exporter</button>
          <button type="button" class="btn" id="btn-import">Importer</button>
        </div>
      </section>

      <section class="block">
        <h2 class="sec">Tout recommencer</h2>
        <button type="button" class="btn danger" id="btn-reset">Effacer toutes les données</button>
      </section>`;

    const root = $('#view-settings');
    // Chaque changement est enregistré tout seul, un court instant après la dernière frappe.
    let timer;
    const changed = () => {
      $('#t-income', root).textContent = money(sumEditor(root, 'income'));
      $('#t-fixed', root).textContent = money(sumEditor(root, 'fixed'));
      clearTimeout(timer);
      timer = setTimeout(saveSettings, 500);
    };
    bindEditor(root, 'income', { ...o, ...DAY.income, suggestions: SUGGEST.income, placeholder: 'Nom de la rentrée' }, changed);
    bindEditor(root, 'fixed', { ...o, ...DAY.fixed, suggestions: SUGGEST.fixed, placeholder: 'Nom de la dépense' }, changed);
    bindEditor(root, 'cat', { ...o, noAmount: true, catAmount: true, withColor: true, suggestions: SUGGEST.cat, placeholder: 'Nom du poste' }, changed);
    $('#set-currency', root).addEventListener('change', () => { saveSettings(); renderSettings(); });
    $('#t-income', root).textContent = money(sumEditor(root, 'income'));
    $('#t-fixed', root).textContent = money(sumEditor(root, 'fixed'));

    flushSettings = () => { if (timer) saveSettings(); };

    function saveSettings() {
      clearTimeout(timer);
      timer = null;
      const err = (m) => {
        $('#set-error', root).textContent = m;
        $('#set-saved', root).textContent = 'Pas encore enregistré : corrigez le problème ci-dessus.';
      };
      const ri = readEditor(root, 'income', { what: 'Ce que vous recevez' });
      if (ri.error) return err(ri.error);
      const rf = readEditor(root, 'fixed', { what: 'Ce qui part tout seul' });
      if (rf.error) return err(rf.error);
      const rc = readEditor(root, 'cat', { what: 'Dépenses de tous les jours' });
      if (rc.error) return err(rc.error);
      const before = { incomes: new Map(state.incomes.map((x) => [x.id, x.amount])), fixed: new Map(state.fixed.map((x) => [x.id, x.amount])), cats: new Map(state.categories.map((c) => [c.id, catMonthly(c)])) };
      state.incomes = ri.items.map(({ id, name, amount, day, emoji }) => ({ id, name, amount, day, emoji }));
      state.fixed = rf.items.map(({ id, name, amount, day, emoji }) => ({ id, name, amount, day, emoji }));
      state.categories = rc.items.map(({ id, name, color, per, amount, emoji }, i) => ({ id, name, color: color || PALETTE[i % PALETTE.length], per, amount, emoji }));
      state.currency = $('#set-currency', root).value;
      // Le budget du mois en cours suit les montants habituels qui viennent de changer.
      const rec = state.months[currentMonth()];
      if (rec) {
        for (const [key, list] of [['incomes', state.incomes], ['fixed', state.fixed]]) {
          for (const item of list) if (before[key].get(item.id) !== item.amount) rec[key][item.id] = item.amount;
        }
        for (const c of state.categories) if (c.per && before.cats.get(c.id) !== catMonthly(c)) rec.budgets[c.id] = catMonthly(c);
      }
      if (!save()) return;
      $('#set-error', root).textContent = '';
      $('#set-saved', root).textContent = 'Enregistré ✓';
    }

    $('#btn-export', root).addEventListener('click', exportData);
    $('#btn-import', root).addEventListener('click', () => $('#import-file').click());
    $('#btn-reset', root).addEventListener('click', () => {
      if (!confirm('Effacer toutes les données de ce téléphone ?')) return;
      if (!confirm('Dernière confirmation : c’est définitif. Avez-vous exporté une sauvegarde ?')) return;
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignoré */ }
      state = null;
      start();
    });
  }

  /* ---------- Sauvegarde : rappel, export, import ---------- */

  const BACKUP_FIRST_DAYS = 7;  // première sauvegarde conseillée une semaine après le début
  const BACKUP_EVERY_DAYS = 30; // puis une fois par mois

  /** Carte « pensez à sauvegarder », ou '' si la sauvegarde est récente. */
  function backupTipHTML() {
    let text;
    if (state.lastBackup) {
      const n = daysSince(state.lastBackup);
      if (n < BACKUP_EVERY_DAYS) return '';
      text = `Dernière sauvegarde il y a ${plural(n, 'jour')}.`;
    } else {
      if (daysSince(state.createdAt) < BACKUP_FIRST_DAYS) return '';
      text = 'Vos données ne sont que sur ce téléphone et n’ont jamais été sauvegardées.';
    }
    return `
      <div class="tip">
        <p>${esc(text)}</p>
        <button type="button" class="link inline" data-backup>Sauvegarder</button>
      </div>`;
  }

  function backupNoteHTML() {
    if (!state.lastBackup) return 'Aucune sauvegarde pour l’instant.';
    const n = daysSince(state.lastBackup);
    return `Dernière sauvegarde : ${n === 0 ? 'aujourd’hui' : n === 1 ? 'hier' : `il y a ${plural(n, 'jour')}`}.`;
  }

  function backupDone(day) {
    state.lastBackup = day;
    save();
    toast('Sauvegarde enregistrée');
    if (ui.view === 'month') renderMonth();
    const note = $('#backup-note');
    if (note) note.textContent = backupNoteHTML();
  }

  async function exportData() {
    const day = todayISO();
    const payload = { app: 'budget-mensuel', exportedAt: new Date().toISOString(), ...state, lastBackup: day };
    const name = `budget-${day}.json`;
    const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });

    // Sur iPhone, la feuille de partage permet « Enregistrer dans Fichiers ».
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    if (touch && navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: name });
        backupDone(day);
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
    backupDone(day);
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
    const summaryText = `${plural(data.incomes.length, 'rentrée')}, ${plural(data.fixed.length, 'dépense fixe')} et ${plural(data.categories.length, 'poste')}`;
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
    if (state) save(); // enregistre au format courant (reprise des anciennes versions)

    $$('.tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
    $('#prev-month').addEventListener('click', () => goMonth(-1));
    $('#next-month').addEventListener('click', () => goMonth(1));
    bindDialog();

    $('#import-file').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importFile(file);
    });

    // Retour sur l’app un autre jour ou un autre mois : on recalcule.
    let lastDay = todayISO();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSettings(); // app fermée juste après une modification
      if (document.visibilityState !== 'visible' || !state) return;
      const now = todayISO();
      if (now === lastDay) return;
      if (now.slice(0, 7) !== lastDay.slice(0, 7)) ui.month = now.slice(0, 7);
      lastDay = now;
      if (ui.view !== 'edit') render();
    });

    start();

    const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
    if ('serviceWorker' in navigator && secure) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  init();
})();
