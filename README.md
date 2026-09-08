# PseudoCode Extension for VS Code

Cette extension permet d'ajouter la coloration syntaxique et l'exécution de pseudo-code en français dans Visual Studio Code.

## Fonctionnalités :
- Coloration des mots-clés (SI, ALORS, etc.).
- Commande pour exécuter directement le pseudo-code.
- Extension légère et rapide à installer.

## Comment exécuter :
- Créez un fichier `.pseudo`.
- Utilisez la commande "Exécuter le pseudo-code" dans VS Code (ou `F5`).

## Prérequis

Un **SDK .NET** doit être installé sur le poste : <https://dotnet.microsoft.com/download>.

La version importe peu. À chaque exécution, l'extension inspecte l'installation
locale et cible la plus haute version majeure disposant à la fois d'un SDK et
d'un runtime : .NET 8, 9, 10 ou toute version ultérieure fonctionnent sans
réglage. Si la version cible change (installation d'un nouveau SDK, par exemple),
le projet C# temporaire est régénéré automatiquement.

## Réglages

| Réglage | Défaut | Rôle |
| --- | --- | --- |
| `pseudocode.targetFramework` | `auto` | Force une version cible, par exemple `net8.0`. `auto` laisse l'extension décider. |
| `pseudocode.dotnetPath` | `dotnet` | Chemin de l'exécutable `dotnet`, à renseigner uniquement s'il n'est pas dans le `PATH`. |

Le canal de sortie **PseudoCode** indique à chaque exécution les SDK et runtimes
détectés ainsi que la version retenue — utile pour diagnostiquer un poste.

## Installation :
1. Téléchargez l'extension via VS Code Marketplace ou packagez-la avec `vsce`.
2. Chargez-la via l'option "Installer depuis un fichier .vsix".

## Fonctionnement interne

L'extension traduit le pseudo-code en C#, puis compile et exécute un programme
console jetable. Tous ses fichiers vivent dans le **stockage global de
l'extension** (`globalStorageUri`), et non dans son dossier d'installation : ils
survivent aux mises à jour et ne sont jamais embarqués dans le `.vsix`.

La compilation emprunte deux voies :

1. **Voie rapide** — le compilateur Roslyn du SDK est appelé directement, avec son
   serveur de compilation persistant. Une exécution complète prend environ
   400 ms, et 100 ms si le pseudo-code n'a pas changé depuis la dernière fois.
2. **Repli MSBuild** — si le SDK n'expose pas les fichiers attendus, l'extension
   bascule sur `dotnet build` (environ 3 s) et l'indique dans le canal de sortie.
   Le résultat est identique, seul le délai change.

À l'ouverture d'un fichier `.pseudo`, l'extension prépare le terrain en tâche de
fond (détection du SDK, démarrage du serveur de compilation) pour que le premier
appui sur `F5` soit déjà rapide.
