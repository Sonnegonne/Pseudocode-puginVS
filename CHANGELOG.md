# Change Log

Toutes les évolutions notables de l'extension « PseudoCodeDC » sont consignées ici.

## [0.5.0]

Verrouillage des complétions par IA sur les fichiers `.pseudo`, pour que
l'élève écrive son algorithme au lieu de valider celui d'un assistant.

### Ajouté

- **Des valeurs par défaut contribuées pour le langage `pseudocode`.** Sur un
  fichier `.pseudo`, l'extension éteint `editor.inlineSuggest.enabled` — le
  « ghost text », quel que soit le fournisseur : Copilot, Codeium, Tabnine… —
  ainsi que les suggestions par mots, la complétion par Tab et les caractères
  déclencheurs, et déclare `pseudocode` parmi les langages désactivés de
  `github.copilot.enable`. Aucune manipulation n'est demandée à l'élève :
  installer l'extension suffit. Les autres langages ne sont pas touchés.
- **Un scellement du réglage.** Un défaut contribué cède devant un réglage
  explicite ; l'extension surveille donc `editor.inlineSuggest` et, dès qu'une
  complétion redevient effective sur un `.pseudo`, réécrit l'override de
  langage à l'échelon utilisateur, puis workspace, puis dossier, en s'arrêtant
  dès que le verrou tient. Un réglage de portée supérieure ne peut donc pas le
  contourner. Tant que la valeur effective est correcte, aucun fichier de
  réglages n'est touché.
- **Le blocage de l'exécution.** L'extension étant le seul interpréteur du
  pseudo-code, `F5` vérifie le verrou avant de compiler et refuse de lancer le
  programme si une complétion par IA reste active. Un élève qui contourne le
  scellement perd la possibilité de tester son algorithme ; un élève qui
  désactive l'extension perd `F5` avec elle.
- **Un témoin permanent dans la barre d'état**, sur les fichiers `.pseudo` :
  « Sans IA » ou, en rouge, « IA active ». Il lit la valeur réellement
  appliquée au fichier ouvert, et non la valeur par défaut. Il n'est plus
  masquable.
- **La commande « PseudoCode : Vérifier les assistants IA »**, également
  accessible en cliquant sur le témoin : elle rescelle le réglage et rend
  compte des extensions de complétion détectées.

### Limites connues

Le verrou porte sur la complétion en ligne dans les fichiers `.pseudo`. Il
n'empêche pas de faire écrire la solution ailleurs — panneau de discussion,
fichier d'un autre langage — puis de la coller. Pour une épreuve
certificative, la déconnexion du compte GitHub reste la mesure de référence.

## [0.3.0]

Performance : l'exécution d'un pseudo-code passe d'environ 6 secondes à moins
d'une demi-seconde.

### Changé

- **Le compilateur Roslyn est appelé directement**, au lieu de passer par
  `dotnet build`. MSBuild imposait un cycle restore + évaluation de projet de 2 à
  3 secondes (6 secondes au premier lancement) pour compiler une vingtaine de
  lignes. Roslyn appelé directement, avec son serveur de compilation persistant,
  fait le même travail en 200 à 400 ms. Aucun projet MSBuild n'est créé et aucun
  restore NuGet n'a lieu tant que cette voie fonctionne.
- **`dotnet build` reste le filet de sécurité.** Si le SDK n'expose pas les
  fichiers attendus, ou si le compilateur ne peut pas être lancé, l'extension
  bascule automatiquement sur MSBuild et le signale dans le canal de sortie. La
  distinction est faite entre une faute dans le code de l'élève (affichée telle
  quelle) et un problème d'outillage (qui déclenche le repli).
- **Un pseudo-code inchangé n'est plus recompilé** : le programme généré est
  empreinté et l'assembly réutilisée telle quelle. Relancer sans modifier prend
  environ 100 ms.
- **Préchauffage à l'ouverture d'un fichier `.pseudo`** : détection du SDK,
  localisation du compilateur et démarrage du serveur Roslyn ont lieu en tâche de
  fond pendant que l'élève écrit, et non au moment où il appuie sur F5.
- Le restore MSBuild n'est plus refait à chaque compilation dans la voie de
  repli, seulement lorsque le projet vient de changer (`--no-restore` sinon) :
  environ 1,2 seconde économisée par exécution.
- `UseAppHost=false` dans le projet de repli : plus de copie d'un exécutable de
  150 Ko à chaque compilation, le programme étant lancé via `dotnet <dll>`.
- La compilation rapide affiche une discrète mention dans la barre d'état au lieu
  d'une notification, trop voyante pour une opération de 300 ms.

### Mesures

Sur un poste équipé du SDK .NET 10, pour le programme d'exemple :

| Scénario | Avant | Après |
| --- | --- | --- |
| Première exécution (rien en cache) | ~6,3 s | ~0,38 s |
| Exécution après modification du code | ~3,1 s | ~0,38 s |
| Ré-exécution sans modification | ~3,1 s | ~0,12 s |
| Repli MSBuild (si la voie rapide échoue) | ~6,3 s | ~3,3 s |

## [0.2.0]

Compatibilité .NET 10 — et, par construction, avec les versions suivantes.

### Corrigé

- **La version de .NET n'est plus codée en dur.** L'extension ciblait `net9.0` et
  le SDK `9.0.101`. Sur un poste équipé du seul SDK .NET 10, la compilation ou le
  lancement échouait. La version cible est désormais détectée à l'exécution :
  l'extension retient la plus haute version majeure disposant **à la fois** d'un
  SDK (pour compiler) et d'un runtime (pour exécuter). Aucune modification ne
  sera nécessaire pour .NET 11, 12, etc.
- **Le projet C# temporaire est remis à niveau automatiquement.** Il n'était créé
  que si son dossier était absent : un projet hérité en `net9.0` le restait
  indéfiniment. Le `.csproj` est maintenant réécrit — et les caches `bin`/`obj`
  purgés — dès que la version cible change.
- **Le projet n'est plus embarqué dans le `.vsix`.** Le paquet contenait un
  `tempApp/` pré-compilé en `net9.0`, dont le `obj/project.assets.json`
  référençait les chemins absolus de la machine de développement. Le projet est
  désormais généré dans le stockage global de l'extension, qui survit aux mises
  à jour et n'est jamais en lecture seule.
- **Les erreurs de compilation sont enfin lisibles.** MSBuild écrit ses erreurs
  sur `stdout` et non sur `stderr` : le message affiché était systématiquement
  vide. Les deux flux sont maintenant combinés.
- **Chemin de `language-configuration.json` corrigé** dans `package.json`
  (`./syntaxes/…`), le fichier n'était pas chargé.
- La bannière de premier lancement et la télémétrie de `dotnet` ne polluent plus
  la sortie du programme (elles pouvaient fausser la détection de la saisie).
- `Console.OutputEncoding` / `InputEncoding` sont fixés dans un `try` : leur échec
  sur une entrée redirigée n'empêche plus le programme de démarrer.
- Le `.csproj` généré déclare `RollForward=LatestMajor` : le binaire produit
  démarre aussi sur un runtime plus récent que celui de compilation.
- L'appel à `dotnet` ne passe plus par un shell (`cd … && dotnet build`), ce qui
  échouait avec PowerShell et avec les chemins comportant des espaces.

### Ajouté

- Réglage `pseudocode.targetFramework` (`auto` par défaut) pour forcer une
  version, par exemple `net8.0`.
- Réglage `pseudocode.dotnetPath` pour les postes où `dotnet` n'est pas dans le
  `PATH`.
- Message d'erreur explicite, avec lien de téléchargement, quand le SDK .NET est
  absent.

## [0.1.5]

- Version initiale.
