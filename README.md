# Budget mensuel

Petite web app de budget mensuel guidée, pensée pour iPhone. HTML/CSS/JS sans framework, sans serveur, sans dépendance.

- **Parcours de départ en 4 étapes** : ce qui rentre chaque mois (salaire, APL, prime d’activité…), ce qui sort chaque mois (loyer, factures, abonnements…), les catégories du quotidien (courses, loisirs…), puis un plan proposé par l’app.
- **Répartir mon mois** : l’app propose combien mettre de côté et combien prévoir pour chaque catégorie, selon trois plans : *Prudent* (risque faible de finir le mois à court, gros coussin), *Équilibré* et *Effort* (risque modéré, on épargne davantage). Les montants proposés sont arrondis à la dizaine ; le reste forme un coussin pour les imprévus. Après quelques mois, les budgets suivent les dépenses réelles. Une nouvelle proposition est faite chaque mois. L’app ne conseille pas de placement.
- **Rentrées et dépenses fixes comptées automatiquement** chaque mois. Leur montant peut être ajusté pour un mois seulement (ex. : APL qui varie) ou pour tous les mois suivants.
- **Mois** : ce qu’il vous reste, un repère « environ X par jour », le détail rentrées / fixes / quotidien / épargne, l’argent sur le compte (à partir du solde indiqué, mis à jour avec les opérations notées et les prélèvements datés), les prélèvements et rentrées encore à venir (si leur jour est indiqué), l’avancement de chaque budget et des conseils (budget dépassé, dépenses trop rapides, objectif d’épargne…).
- **Graphiques** (dessinés par l’app, sans bibliothèque, fonctionnent hors ligne) : où va l’argent du mois, rythme des dépenses face au budget, avancement de chaque catégorie (dans sa couleur), rentrées et dépenses des 6 derniers mois, évolution de l’épargne.
- **Importer des opérations** : relevé bancaire (OFX ou CSV, par exemple Crédit Agricole ou Caisse d’Épargne) ou journal des paiements Apple Pay écrit par un raccourci iOS (`date;montant;commerçant` par ligne). L’app propose une catégorie (et retient vos corrections), écarte les doublons (déjà notés, déjà comptés dans les rentrées ou dépenses fixes, déjà importés) et vous laisse tout vérifier avant d’ajouter. Le fichier est lu sur l’appareil, rien n’est envoyé.
- **Ajouter** : dépense du quotidien, rentrée ponctuelle (prime, remboursement…) ou épargne (mettre de côté / retirer).
- **Épargne** : total épargné et sa courbe d’évolution, objectif du mois, historique mois par mois avec l’argent non dépensé.
- **Historique** : opérations notées du mois ; toucher une ligne pour la modifier.
- **Réglages** : tout modifier, **Exporter / Importer** en JSON, tout effacer. L’app indique la date de la dernière sauvegarde et rappelle d’en faire une (une semaine après la première opération, puis tous les 30 jours).
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
  "version": 2,
  "currency": "EUR",
  "savingsTarget": 5000,
  "savingsStart": 0,
  "incomes": [
    { "id": "i1", "name": "Salaire", "amount": 150000, "from": "2026-01", "until": null, "day": 28 }
  ],
  "fixed": [
    { "id": "f1", "name": "Loyer", "amount": 60000, "from": "2026-01", "until": null, "day": 5 }
  ],
  "categories": [
    { "id": "c1", "name": "Courses", "budget": 30000, "color": "#2f855a" }
  ],
  "overrides": { "2026-02": { "i1": 145000 } },
  "plan": "equilibre",
  "planMonth": "2026-01",
  "transactions": [
    { "id": "t1", "type": "expense", "date": "2026-01-12", "amount": 2450, "categoryId": "c1", "note": "Exemple" },
    { "id": "t2", "type": "income", "date": "2026-01-20", "amount": 10000, "categoryId": null, "note": "" },
    { "id": "t3", "type": "saving", "date": "2026-01-25", "amount": 5000, "categoryId": null, "note": "" }
  ]
}
```

- Montants en **centimes** (`2450` = 24,50 €).
- `incomes` / `fixed` : comptés chaque mois de `from` à `until` (inclus, `null` = sans fin).
- `day` (facultatif, 1 à 31 ou `null`) : jour où la rentrée arrive ou la dépense est prélevée ; sert à la liste « À venir ce mois-ci ».
- `ref` (facultatif, sur une opération) : empreinte de l’opération importée ; `seenRefs` : opérations importées puis écartées ; `rules` : catégorie retenue par commerçant.
- `bank` (facultatif) : dernier solde du compte indiqué, `{ "amount": centimes (peut être négatif), "date": "AAAA-MM-JJ" }`.
- `lastBackup` : jour de la dernière sauvegarde exportée (ou `null`).
- `plan` : dernier plan choisi (`prudent`, `equilibre` ou `effort`) ; `planMonth` : mois où il a été appliqué.
- `overrides` : montant d’une rentrée ou dépense fixe pour un mois précis.
- `type` d’opération : `expense` (dépense du quotidien), `income` (rentrée ponctuelle), `saving` (mise de côté), `withdrawal` (retrait d’épargne).
- Les fichiers de la version 1 s’importent aussi.

L’import vérifie la structure du fichier et remplace les données présentes sur l’appareil après confirmation.

Les fichiers exportés contiennent vos finances : ne les ajoutez pas au dépôt (le `.gitignore` exclut `budget-*.json`).
