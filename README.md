# Budget mensuel

Petite web app de budget mensuel guidée, pensée pour iPhone. HTML/CSS/JS sans framework, sans serveur, sans dépendance.

Une app volontairement simple : elle ne remplace pas l’app de votre banque et ne note pas chaque dépense.

- **Parcours de départ en 4 étapes** : ce que vous recevez chaque mois (salaire, chômage, APL…), ce qui part tout seul (loyer, factures, abonnements, avec le jour du prélèvement), vos dépenses de tous les jours (courses, tabac, loisirs…) avec leur montant si vous le connaissez (par mois ou par semaine), sinon l’app le propose ; puis un plan proposé par l’app.
- **Budget du mois** : chaque mois, vous vérifiez ce que vous allez recevoir (ça peut changer d’un mois à l’autre) et ce qui sera prélevé. L’app propose combien mettre sur le livret et combien prévoir pour chaque poste, selon trois plans : *Prudent*, *Équilibré* et *Effort*. Les montants sont arrondis à la dizaine ; le reste forme une marge pour les imprévus. Une case « J’ai fait le virement » pour l’épargne.
- **Combien dépenser par jour** : vous recopiez le solde affiché par l’app de votre banque. L’app enlève les prélèvements encore à venir ce mois-ci et l’épargne pas encore virée, puis divise par le nombre de jours restants. L’argent qui n’est pas encore arrivé n’est pas compté.
- **Épargne** : vous recopiez de temps en temps le solde du livret ; l’app trace sa courbe.
- **Réglages** : rentrées et dépenses fixes habituelles, postes, devise, **Exporter / Importer** en JSON (avec rappel de sauvegarde), tout effacer.
- Fonctionne **hors ligne** une fois chargée (service worker) et s’installe sur l’écran d’accueil.

## Confidentialité

Aucune donnée n’est envoyée nulle part : il n’y a ni serveur, ni compte, ni statistiques, ni ressource externe.
Les données sont enregistrées dans le `localStorage` du navigateur, **sur l’appareil uniquement**.
Le dépôt ne contient que du code et des noms de catégories génériques proposés au démarrage.

## Installation sur iPhone

1. Ouvrir l’adresse GitHub Pages dans **Safari**.
2. Bouton **Partager** → **Sur l’écran d’accueil**.
3. Lancer l’app depuis l’icône.

> Important : Safari peut effacer les données d’un site non utilisé depuis plusieurs semaines lorsqu’il n’est pas ajouté à l’écran d’accueil. Installez l’app sur l’écran d’accueil et **exportez régulièrement** une sauvegarde (Réglages → Exporter → « Enregistrer dans Fichiers »).
> Les données de l’app installée et celles de Safari sont séparées : pour passer de l’une à l’autre, utilisez Exporter / Importer.

## Publication sur GitHub Pages

1. Pousser ces fichiers à la racine d’un dépôt GitHub.
2. **Settings → Pages** → Source : *Deploy from a branch*, branche `main`, dossier `/ (root)`.
3. L’app est disponible à `https://<utilisateur>.github.io/<dépôt>/`.

Les mises à jour poussées sur GitHub sont récupérées automatiquement au lancement suivant quand l’appareil est en ligne ; hors ligne, l’app utilise la dernière version mise en cache.

## Tester en local

```bash
python3 -m http.server 8000
```

Puis ouvrir http://localhost:8000.

## Format du fichier exporté

```json
{
  "app": "budget-mensuel",
  "exportedAt": "2026-01-31T18:00:00.000Z",
  "version": 3,
  "currency": "EUR",
  "incomes": [{ "id": "i1", "name": "Salaire", "amount": 150000, "day": 28 }],
  "fixed": [{ "id": "f1", "name": "Loyer", "amount": 60000, "day": 5 }],
  "categories": [
    { "id": "c1", "name": "Courses", "color": "#2f855a", "per": "week", "amount": 4000 },
    { "id": "c2", "name": "Loisirs", "color": "#2b6cb0", "per": null, "amount": null }
  ],
  "plan": "equilibre",
  "months": {
    "2026-01": {
      "incomes": { "i1": 145000 },
      "fixed": { "f1": 60000 },
      "plan": "equilibre",
      "save": 15000,
      "saveDone": false,
      "budgets": { "c1": 30000 }
    }
  },
  "bank": { "amount": 84050, "date": "2026-01-12" },
  "savings": [{ "date": "2026-01-01", "amount": 120000 }],
  "createdAt": "2026-01-01",
  "lastBackup": null
}
```

- Montants en **centimes** (`2450` = 24,50 €).
- `incomes` / `fixed` : montants habituels ; `day` (1 à 31 ou `null`) : jour où la rentrée arrive ou la dépense est prélevée.
- `categories` : `per` = `month` ou `week` quand vous connaissez le montant (`amount`), `null` pour que l’app le propose.
- `months` : le budget validé de chaque mois (montants du mois, épargne prévue, budget par poste).
- `bank` : dernier solde du compte courant recopié (peut être négatif).
- `savings` : soldes du livret recopiés, pour la courbe.
- Les fichiers des versions 1 et 2 s’importent aussi : rentrées, dépenses fixes, postes, budget du mois en cours et total d’épargne sont repris ; le détail des dépenses ne l’est pas. Au premier lancement de la version 3, l’ancienne copie est gardée dans le `localStorage` sous `budget-mensuel:avant-v3`.

L’import vérifie la structure du fichier et remplace les données présentes sur l’appareil après confirmation.

Les fichiers exportés contiennent vos finances : ne les ajoutez pas au dépôt (le `.gitignore` exclut `budget-*.json`).
