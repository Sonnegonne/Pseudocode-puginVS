const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CONFIG = {
    // Framework de repli utilisé uniquement si la détection du SDK échoue.
    // La version réellement utilisée est déterminée à l'exécution par DotnetEnvironment.
    fallbackFrameworkVersion: 'net8.0',
    tempDirectoryName: 'tempApp',
    // Avertissements sans intérêt sur du code généré : une variable déclarée en
    // pseudo-code mais jamais utilisée est normale et ne doit pas alarmer l'élève.
    suppressedWarnings: ['CS8600', 'CS8601', 'CS8602', 'CS8604', 'CS0168', 'CS0219', 'CS0169', 'CS0414'],
    typeMapping: {
        "entier": "int",
        "chaine de caracteres": "string",
        "caracteres": "string",
        "numerique": "double",
        "booleen": "bool"
    }
};

// Variables d'environnement passées à chaque appel `dotnet` : elles suppriment
// la bannière de premier lancement et la télémétrie, qui polluent stdout et
// perturbent la détection du marqueur de saisie (\u200B).
const DOTNET_ENV = {
    ...process.env,
    DOTNET_NOLOGO: '1',
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_ADD_GLOBAL_TOOLS_TO_PATH: '0'
};

/** Compare deux versions « major.minor.patch » (le suffixe -preview est ignoré). */
function compareVersions(a, b) {
    const parse = (v) => String(v).split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
    const [pa, pb] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) { return diff; }
    }
    return 0;
}

/**
 * Détecte l'installation .NET de la machine au lieu de la coder en dur.
 * Le projet temporaire cible alors la plus haute version majeure disponible
 * à la fois en SDK et en runtime, ce qui rend l'extension compatible avec
 * .NET 8, 9, 10 et les versions à venir sans modification.
 */
class DotnetEnvironment {
    constructor(dotnetPath) {
        this.dotnetPath = dotnetPath || 'dotnet';
        this._cache = null;
    }

    /** Exécute une commande `dotnet` courte et renvoie sa sortie standard. */
    runCapture(args) {
        return new Promise((resolve) => {
            let child;
            try {
                child = spawn(this.dotnetPath, args, { env: DOTNET_ENV, shell: false });
            } catch {
                resolve(null);
                return;
            }
            let stdout = '';
            child.stdout.on('data', (d) => { stdout += d; });
            child.stderr.on('data', () => {});
            child.on('error', () => resolve(null));
            child.on('close', (code) => resolve(code === 0 ? stdout : null));
        });
    }

    /**
     * Analyse les lignes « [prefix]version [chemin] » produites par
     * `dotnet --list-sdks` et `dotnet --list-runtimes`.
     */
    static parseEntries(output, prefix) {
        if (!output) { return []; }
        const entries = [];
        for (const rawLine of output.split(/\r?\n/)) {
            let line = rawLine.trim();
            if (!line) { continue; }
            if (prefix) {
                if (!line.startsWith(prefix)) { continue; }
                line = line.slice(prefix.length).trim();
            }
            const match = line.match(/^(\d+(?:\.\d+)*(?:-[\w.]+)?)\s+\[(.+)\]$/);
            if (!match) { continue; }
            entries.push({ version: match[1], dir: match[2], major: parseInt(match[1], 10) });
        }
        return entries.sort((a, b) => compareVersions(a.version, b.version));
    }

    /** Versions majeures distinctes, triées, d'une liste d'entrées. */
    static majorsOf(entries) {
        return [...new Set(entries.map(e => e.major))].sort((a, b) => a - b);
    }

    /**
     * Renvoie les caractéristiques de l'installation .NET locale.
     * Le résultat est mis en cache pour la session.
     */
    async detect() {
        if (this._cache) { return this._cache; }

        const [sdksOut, runtimesOut] = await Promise.all([
            this.runCapture(['--list-sdks']),
            this.runCapture(['--list-runtimes'])
        ]);

        if (sdksOut === null) {
            this._cache = {
                available: false,
                targetFramework: CONFIG.fallbackFrameworkVersion,
                sdkMajors: [], runtimeMajors: [], sdks: [], runtimes: [], root: null
            };
            return this._cache;
        }

        const sdks = DotnetEnvironment.parseEntries(sdksOut, null);
        const runtimes = DotnetEnvironment.parseEntries(runtimesOut, 'Microsoft.NETCore.App');
        const sdkMajors = DotnetEnvironment.majorsOf(sdks);
        const runtimeMajors = DotnetEnvironment.majorsOf(runtimes);

        // On cible la plus haute version majeure disposant à la fois d'un SDK
        // (pour compiler) et d'un runtime (pour exécuter). Sans ce croisement,
        // une machine dotée du seul SDK 10 compilerait en net9.0 puis échouerait
        // au lancement faute de runtime 9.
        const common = sdkMajors.filter(m => runtimeMajors.includes(m));
        const major = common.length > 0
            ? common[common.length - 1]
            : (sdkMajors.length > 0 ? sdkMajors[sdkMajors.length - 1] : null);

        // La racine .NET se déduit du dossier des SDK (« …/dotnet/sdk »).
        const root = sdks.length > 0 ? path.dirname(sdks[sdks.length - 1].dir) : null;

        this._cache = {
            available: true,
            targetFramework: major !== null ? `net${major}.0` : CONFIG.fallbackFrameworkVersion,
            major,
            sdks,
            runtimes,
            sdkMajors,
            runtimeMajors,
            root
        };
        return this._cache;
    }
}

/**
 * Voie rapide : appelle directement le compilateur Roslyn du SDK au lieu de
 * passer par MSBuild.
 *
 * `dotnet build` impose un cycle restore + évaluation MSBuild d'environ 2 à 3
 * secondes (6 secondes au premier lancement) pour un programme d'une vingtaine
 * de lignes. Roslyn appelé directement, avec son serveur de compilation
 * persistant (`-shared`), fait le même travail en 200 à 400 ms.
 *
 * Cette voie est un accélérateur, jamais une obligation : si le SDK n'expose
 * pas les fichiers attendus, `isAvailable()` renvoie false et l'appelant
 * retombe sur MSBuild.
 */
class FastCompiler {
    constructor(workDir, output) {
        this.workDir = workDir;
        this.output = output;
        this.plan = null;
    }

    isAvailable() { return this.plan !== null; }

    /**
     * Localise `csc.dll` et les assemblys de référence, puis écrit le fichier
     * réponse et le runtimeconfig. Renvoie false si la voie rapide n'est pas
     * praticable sur cette machine.
     */
    prepare(info, framework, dotnetPath) {
        this.plan = null;
        if (!info.available || !info.root) { return false; }

        try {
            // Le compilateur du SDK le plus récent sait cibler les frameworks
            // antérieurs : on prend donc simplement le plus récent installé.
            let cscPath = null;
            for (let i = info.sdks.length - 1; i >= 0; i--) {
                const candidate = path.join(info.root, 'sdk', info.sdks[i].version, 'Roslyn', 'bincore', 'csc.dll');
                if (fs.existsSync(candidate)) { cscPath = candidate; break; }
            }
            if (!cscPath) { return false; }

            // Assemblys de référence du framework ciblé. On n'utilise jamais le
            // dossier « shared » : il mêle des DLL natives que Roslyn refuse.
            const packRoot = path.join(info.root, 'packs', 'Microsoft.NETCore.App.Ref');
            if (!fs.existsSync(packRoot)) { return false; }

            let refDir = null;
            const versions = fs.readdirSync(packRoot).sort(compareVersions);
            for (let i = versions.length - 1; i >= 0; i--) {
                const candidate = path.join(packRoot, versions[i], 'ref', framework);
                if (fs.existsSync(candidate)) { refDir = candidate; break; }
            }
            if (!refDir) { return false; }

            const references = fs.readdirSync(refDir).filter(f => f.toLowerCase().endsWith('.dll'));
            if (references.length === 0) { return false; }

            fs.mkdirSync(this.workDir, { recursive: true });

            // Fichier réponse : les chemins sont entre guillemets, sinon
            // « C:\Program Files\… » serait coupé sur l'espace.
            const rspPath = path.join(this.workDir, 'references.rsp');
            const rsp = references.map(f => `-r:"${path.join(refDir, f)}"`).join('\n') + '\n';
            if (!fs.existsSync(rspPath) || fs.readFileSync(rspPath, 'utf8') !== rsp) {
                fs.writeFileSync(rspPath, rsp, 'utf8');
            }

            // Runtime le plus récent de la version majeure ciblée.
            const major = parseInt(framework.replace(/^net/, ''), 10);
            const matching = info.runtimes.filter(r => r.major === major);
            const runtimeVersion = matching.length > 0
                ? matching[matching.length - 1].version
                : `${major}.0.0`;

            this.plan = { cscPath, rspPath, framework, runtimeVersion, dotnetPath };
            return true;
        } catch {
            this.plan = null;
            return false;
        }
    }

    /** Le runtimeconfig que MSBuild aurait généré pour ce projet. */
    writeRuntimeConfig(outputDll) {
        const configPath = outputDll.replace(/\.dll$/, '.runtimeconfig.json');
        const content = JSON.stringify({
            runtimeOptions: {
                tfm: this.plan.framework,
                framework: { name: 'Microsoft.NETCore.App', version: this.plan.runtimeVersion },
                rollForward: 'LatestMajor'
            }
        }, null, 2) + '\n';
        if (!fs.existsSync(configPath) || fs.readFileSync(configPath, 'utf8') !== content) {
            fs.writeFileSync(configPath, content, 'utf8');
        }
    }

    /**
     * Compile `sourceFile` vers `outputDll`.
     * Renvoie { status: 'ok' } | { status: 'error', message } | { status: 'unavailable' }.
     * Le statut « unavailable » signale un problème d'outillage — et non une
     * faute dans le code de l'élève — et doit déclencher le repli MSBuild.
     */
    compile(sourceFile, outputDll) {
        return new Promise((resolve) => {
            if (!this.plan) { resolve({ status: 'unavailable' }); return; }

            fs.mkdirSync(path.dirname(outputDll), { recursive: true });
            this.writeRuntimeConfig(outputDll);

            const args = [
                'exec', this.plan.cscPath,
                '-nologo',
                '-shared',        // serveur de compilation persistant : c'est lui qui fait le gain
                '-utf8output',    // sans quoi les messages accentués arrivent illisibles
                '-target:exe',
                '-langversion:latest',
                `-nowarn:${CONFIG.suppressedWarnings.join(',')}`,
                `-out:${outputDll}`,
                `@${this.plan.rspPath}`,
                sourceFile
            ];

            let child;
            try {
                child = spawn(this.plan.dotnetPath, args, { cwd: this.workDir, env: DOTNET_ENV, shell: false });
            } catch {
                resolve({ status: 'unavailable' });
                return;
            }

            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.stderr.on('data', (d) => { out += d; });
            child.on('error', () => resolve({ status: 'unavailable' }));
            child.on('close', (code) => {
                if (code === 0) { resolve({ status: 'ok' }); return; }
                // Une erreur « CS… » vient du code compilé ; tout le reste
                // (csc introuvable, référence illisible) relève de l'outillage.
                if (/error CS\d+/.test(out)) {
                    resolve({ status: 'error', message: out.trim() });
                } else {
                    resolve({ status: 'unavailable' });
                }
            });
        });
    }
}

class PseudoCodeTranslator {
    static translate(pseudoCode) {
        try {
            const siCount = (pseudoCode.match(/\bSI\b/g) || []).length;
            const finsiCount = (pseudoCode.match(/\bFINSI\b/g) || []).length;

            if (siCount !== finsiCount) {
                throw new Error("Chaque SI doit être accompagné d'un FINSI");
            }

            const whileCount = (pseudoCode.match(/\bTANTQUE\b/g) || []).length;
            const whileEndCount = (pseudoCode.match(/\bFINTANTQUE\b/g) || []).length;

            if (whileCount !== whileEndCount) {
                throw new Error("Chaque TANTQUE doit être accompagné d'un FINTANTQUE");
            }

            const forCount = (pseudoCode.match(/\bPOUR\b/g) || []).length;
            const forEndCount = (pseudoCode.match(/\bFINPOUR\b/g) || []).length;

            if (forCount !== forEndCount*2) {
                throw new Error("Chaque POUR doit être accompagné d'un FINPOUR");
            }

            let tempStringMap = {};
            let stringIndex = 0;
    
            pseudoCode = pseudoCode.replace(/"[^"]*"/g, (match) => {
                const key = `__STR${stringIndex}__`;
                tempStringMap[key] = match;
                stringIndex++;
                return key;
            });

            let tempCommentMap = {};
            let commentIndex = 0;
            
            pseudoCode = pseudoCode.replace(/(\/\/[^\n]*|\/\*[\s\S]*?\*\/)/g, (match) => {
                const key = `__CMT${commentIndex}__`;
                tempCommentMap[key] = match;
                commentIndex++;
                return key;
            });
    
            // Extraire les déclarations de variables pour préfixer tous les noms de variables
            const variableDeclarations = [];
            pseudoCode.replace(/variables?\s+(.+?)\s+en\s+(entier|chaine\s+de\s+caracteres|caracteres|numerique|booleen)/g,
                (_, variables, type) => {
                    const vars = variables.split(',').map(v => v.trim());
                    variableDeclarations.push(...vars);
                    return '';
                }
            );
            
            // Ajouter le préfixe _var_ à toutes les variables SAUF dans les déclarations
            // (car translateVariables s'en chargera)
            let prefixedPseudoCode = pseudoCode;
            
            // On remplace d'abord les variables dans le code, mais pas dans les déclarations
            if (variableDeclarations.length > 0) {
                const variableRegex = new RegExp(`\\b(${variableDeclarations.join('|')})\\b(?!.*\\ben\\b)`, 'g');
                prefixedPseudoCode = pseudoCode.replace(variableRegex, '_var_$1');
            }
            
            // Traduction des variables avec préfixe dans les déclarations
            let translated = this.translateVariables(
                prefixedPseudoCode
                    .replace(/(\w+)\s*\+\s*(.+)/g, (_, el1, el2) => `Addition(${el1}, ${el2})`)
                    .replace(/(?<![<>])=/g, '==')
                    .replace(/POUR\s+(\w+)\s*<-\s*(\w+|\d+)\s+à\s+(\w+|\d+)([\s\S]*?)POUR SUIVANT/g, 
                            (_, variable, debut, fin, instructions) => 
                            `for(var ${variable} = ${debut}; ${variable} <= ${fin}; ${variable}++) {${instructions}`)
                    .replace(/<>/g, '!=')
                    .replace(/(\w+)\s*<-\s*(.+)/g, (_, varName, value) => `${varName} = ${value};`)
                    .replace(/&/g, ' + "" + ')
                    .replace(/%/g, '-------')
                    .replace(/\bET\b/g, '&&')
                    .replace(/\bOU\b/g, '||')
                    .replace(/\bNON\b/g, '!')
                    .replace(/\bXOR\b/g, '^')
                    .replace(/\bmod\b/g, '%')
                    .replace(/\bVRAI\b/g, 'true')
                    .replace(/\bFAUX\b/g, 'false')
                    .replace(/\bECRIRE\s+(.+)/g, (_, expression) => `Console.WriteLine(${expression});`)
                    .replace(/\bLIRE\s+(\w+)/g, (_, varName) => (`
                        Console.Write("\u200B"); 
                        ${varName} = (dynamic)Convert.ChangeType(Console.ReadLine(), ${varName}.GetType());
                        Console.WriteLine(${varName});`
                    ))
                    .replace(/\bSI\s+(.+)\s+ALORS\b/g, (_, condition) => `if(${condition}) {`)
                    .replace(/\bSINONSI\s+(.+)\s+ALORS\b/g, (_, condition) => `} else if(${condition}) {`)
                    .replace(/\bSINON\b/g, '} else {')
                    .replace(/\bFINSI\b/g, '}')
                    .replace(/\bTANTQUE\s+(.+)\s+\b/g, (_, condition) => `while(${condition}) {`)
                    .replace(/\bFINTANTQUE\b/g, '}')
                    .replace(/\FINPOUR\b/g, '}')
                    .replace(/\bDEBUT\b/g, 'static void Main() {')
                    .replace(/\bFIN\b/g, '}')
            );

            Object.keys(tempCommentMap).forEach(key => {
                translated = translated.replace(key, tempCommentMap[key]);
            });

            Object.keys(tempStringMap).forEach(key => {
                translated = translated.replace(key, tempStringMap[key]);
            });
    
            return translated;
        } catch (error) {
            throw new Error(`Erreur lors de la traduction: ${error.message}`);
        }
    }

    static translateVariables(code) {
        try {
            return code.replace(/variables?\s+(.+?)\s+en\s+(entier|chaine\s+de\s+caracteres|caracteres|numerique|booleen)/g, 
                (_, variables, type) => {
                    // Attention: on n'ajoute le préfixe qu'une seule fois ici
                    const vars = variables.split(',').map(v => v.trim()).map(v => `_var_${v}`);
                    const cType = CONFIG.typeMapping[type] || "var";
                    if(cType == 'string'){
                        return `static ${cType} ${vars.map(v => `${v} = ""`).join(', ')};`;
                    }else{
                        return `static ${cType} ${vars.join(', ')};`
                    }
                }
            );
        } catch (error) {
            throw new Error(`Erreur lors de la traduction des variables: ${error.message}`);
        }
    }
}

class CSharpProjectManager {
    constructor(context) {
        this.output = vscode.window.createOutputChannel("PseudoCode");
        this.context = context;

        // Le projet temporaire vit dans le stockage global de l'extension et non
        // dans son dossier d'installation : celui-ci change à chaque mise à jour,
        // peut être en lecture seule et se retrouve embarqué dans le .vsix.
        this.storageRoot = this.resolveStorageRoot(context);
        this.tempAppDir = path.join(this.storageRoot, CONFIG.tempDirectoryName);
        this.projectFile = path.join(this.tempAppDir, 'tempApp.csproj');
        this.programFile = path.join(this.tempAppDir, 'Program.cs');
        this.csharpCodeFile = path.join(this.tempAppDir, 'CSharpCode.txt');
        this.cacheFile = path.join(this.tempAppDir, '.build-cache.json');
        // Volontairement en dehors du dossier du projet MSBuild : celui-ci
        // compile tous les .cs qu'il contient, y compris en sous-dossier, et
        // le stub de prechauffage y ajouterait un second point d'entree.
        this.fastOutputDir = path.join(this.storageRoot, 'fast');

        this.dotnet = new DotnetEnvironment(this.dotnetPath);
        this.fastCompiler = new FastCompiler(this.fastOutputDir, this.output);
        this.projectReady = false;
        this.currentProcess = null;
        this.currentInputBox = null;
        this.stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.stopButton.text = "$(debug-stop) Stop Execution";
        this.stopButton.command = 'pseudocode.stop';
        context.subscriptions.push(this.stopButton);
    }

    resolveStorageRoot(context) {
        const uri = context.globalStorageUri;
        if (uri && uri.fsPath) { return uri.fsPath; }
        if (context.globalStoragePath) { return context.globalStoragePath; }
        return context.extensionPath;
    }

    getSetting(key, defaultValue) {
        const value = vscode.workspace.getConfiguration('pseudocode').get(key);
        return (value === undefined || value === null || value === '') ? defaultValue : value;
    }

    /** Chemin de l'exécutable dotnet, configurable s'il est absent du PATH. */
    get dotnetPath() {
        return this.getSetting('dotnetPath', 'dotnet');
    }

    /**
     * Prépare le terrain sans bloquer l'utilisateur, dès l'ouverture d'un
     * fichier `.pseudo` : détection du SDK, localisation du compilateur, et
     * démarrage du serveur Roslyn par une compilation à blanc. Le temps
     * d'installation est ainsi consommé pendant que l'élève écrit son code,
     * et non au moment où il appuie sur F5.
     */
    async warmUp() {
        try {
            const info = await this.dotnet.detect();
            if (!info.available) { return; }

            const framework = this.getSetting('targetFramework', 'auto') === 'auto'
                ? info.targetFramework
                : this.getSetting('targetFramework', 'auto');

            if (!this.fastCompiler.prepare(info, framework, this.dotnetPath)) { return; }

            // Compilation à blanc : son seul but est de lancer VBCSCompiler,
            // qui restera disponible pour les compilations suivantes.
            const probe = path.join(this.fastOutputDir, 'warmup.cs');
            fs.mkdirSync(this.fastOutputDir, { recursive: true });
            fs.writeFileSync(probe, 'class Warmup { static void Main() { } }\n', 'utf8');
            await this.fastCompiler.compile(probe, path.join(this.fastOutputDir, 'warmup.dll'));
        } catch {
            // Le préchauffage est un confort : son échec ne doit rien casser.
        }
    }

    async execute(pseudoCode) {
        if (!pseudoCode?.trim()) {
            vscode.window.showErrorMessage('Le code source est vide !');
            return;
        }

        this.output.show();
        this.output.clear();
        this.stopButton.show();
        this.closeInputBox();

        try {
            const translatedCode = PseudoCodeTranslator.translate(pseudoCode);
            const framework = await this.resolveTargetFramework();
            await this.buildAndRun(translatedCode, framework);
        } catch (error) {
            vscode.window.showErrorMessage(`Erreur de compilation : ${error.message}`);
        } finally {
            this.stopButton.hide();
        }
    }

    /**
     * Détermine le framework cible : celui forcé dans les réglages, sinon celui
     * détecté sur la machine. Lève une erreur explicite si le SDK est absent.
     */
    async resolveTargetFramework() {
        const forced = this.getSetting('targetFramework', 'auto');
        if (forced !== 'auto') { return forced; }

        const info = await this.dotnet.detect();
        if (!info.available) {
            throw new Error(
                "Le SDK .NET est introuvable. Installez-le depuis https://dotnet.microsoft.com/download " +
                "puis redémarrez VS Code (ou renseignez le réglage « pseudocode.dotnetPath »)."
            );
        }
        return info.targetFramework;
    }

    closeInputBox() {
        if (this.currentInputBox) {
            this.currentInputBox.dispose();
            this.currentInputBox = null;
        }
    }

    stopExecution() {
        if (this.currentProcess) {
            try {
                // Fermer l'InputBox si elle est ouverte
                this.closeInputBox();

                // Terminer le processus
                this.currentProcess.kill();
                this.output.appendLine("\n[Exécution arrêtée par l'utilisateur]");
                this.stopButton.hide();
                this.currentProcess = null;
            } catch (error) {
                console.error("Erreur lors de l'arrêt du processus:", error);
                this.stopButton.hide();
                this.currentProcess = null;
                this.currentInputBox = null;
            }
        }
    }

    /**
     * Contenu du .csproj, écrit par l'extension elle-même plutôt que par
     * `dotnet new` : aucune dépendance aux modèles du SDK (dont la liste des
     * frameworks proposés change à chaque version) ni au réseau.
     * `RollForward=LatestMajor` permet en outre au binaire produit de démarrer
     * sur un runtime plus récent que celui utilisé à la compilation.
     */
    buildProjectFileContent(framework) {
        return [
            '<Project Sdk="Microsoft.NET.Sdk">',
            '',
            '  <PropertyGroup>',
            '    <OutputType>Exe</OutputType>',
            `    <TargetFramework>${framework}</TargetFramework>`,
            '    <AssemblyName>tempApp</AssemblyName>',
            '    <RootNamespace>tempApp</RootNamespace>',
            '    <ImplicitUsings>enable</ImplicitUsings>',
            '    <Nullable>disable</Nullable>',
            '    <LangVersion>latest</LangVersion>',
            '    <RollForward>LatestMajor</RollForward>',
            '    <SatelliteResourceLanguages>en</SatelliteResourceLanguages>',
            // Pas d'apphost : évite de recopier un exécutable de 150 Ko à chaque
            // compilation, alors que le programme est lancé via « dotnet <dll> ».
            '    <UseAppHost>false</UseAppHost>',
            '    <GenerateDocumentationFile>false</GenerateDocumentationFile>',
            `    <NoWarn>$(NoWarn);${CONFIG.suppressedWarnings.join(';')}</NoWarn>`,
            '  </PropertyGroup>',
            '',
            '  <ItemGroup>',
            '    <!-- Securite : aucun fichier de la voie rapide ne doit etre compile ici. -->',
            '    <Compile Remove="fast/**" />',
            '  </ItemGroup>',
            '',
            '</Project>',
            ''
        ].join('\n');
    }

    /**
     * Crée le projet MSBuild s'il n'existe pas et le remet à niveau si le
     * framework cible a changé (nouvelle version de .NET installée, projet
     * hérité d'une ancienne version de l'extension). Sans cette remise à
     * niveau, un projet figé en net9.0 le restait indéfiniment.
     *
     * N'est appelée que par la voie MSBuild : quand la voie rapide fonctionne,
     * aucun projet n'est créé et aucun restore NuGet n'a lieu.
     */
    async ensureProjectExists(framework) {
        const desired = this.buildProjectFileContent(framework);
        const current = fs.existsSync(this.projectFile)
            ? fs.readFileSync(this.projectFile, 'utf8')
            : null;

        if (current === desired) {
            return current !== null && this.projectReady;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: current === null ? "Création du projet C#" : `Mise à niveau du projet C# vers ${framework}`,
            cancellable: false
        }, async () => {
            fs.mkdirSync(this.tempAppDir, { recursive: true });

            // Les caches de compilation référencent l'ancien framework et des
            // chemins absolus ; ils doivent disparaître avant de recompiler.
            for (const dir of ['bin', 'obj']) {
                fs.rmSync(path.join(this.tempAppDir, dir), { recursive: true, force: true });
            }
            // Un global.json résiduel épinglerait une version de SDK désinstallée.
            fs.rmSync(path.join(this.tempAppDir, 'global.json'), { force: true });

            fs.writeFileSync(this.projectFile, desired, 'utf8');
        });

        this.projectReady = false;
        return false;
    }

    readCache() {
        try {
            return JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        } catch {
            return null;
        }
    }

    writeCache(entry) {
        try {
            fs.writeFileSync(this.cacheFile, JSON.stringify(entry), 'utf8');
        } catch {
            // Le cache est une optimisation : son échec n'est pas bloquant.
        }
    }

    async buildAndRun(translatedCode, framework) {
        this.translatedCode = translatedCode;
        const programContent = this.generateProgramContent(translatedCode);
        const hash = crypto.createHash('sha1').update(programContent + '|' + framework).digest('hex');

        fs.mkdirSync(this.tempAppDir, { recursive: true });
        fs.writeFileSync(this.programFile, programContent, 'utf8');
        fs.writeFileSync(this.csharpCodeFile, translatedCode, 'utf8');

        // 1. Le programme est-il déjà compilé à l'identique ? Relancer un code
        //    inchangé ne doit rien recompiler du tout.
        const cached = this.readCache();
        if (cached && cached.hash === hash && fs.existsSync(cached.dll)) {
            await this.runProgram(cached.dll);
            return;
        }

        // 2. Voie rapide : Roslyn appelé directement.
        const info = await this.dotnet.detect();
        if (info.available && this.fastCompiler.prepare(info, framework, this.dotnetPath)) {
            const dll = path.join(this.fastOutputDir, 'tempApp.dll');
            const status = vscode.window.setStatusBarMessage('$(sync~spin) Compilation du pseudo-code…');
            let result;
            try {
                result = await this.fastCompiler.compile(this.programFile, dll);
            } finally {
                status.dispose();
            }

            if (result.status === 'ok') {
                this.writeCache({ hash, dll, framework });
                await this.runProgram(dll);
                return;
            }
            if (result.status === 'error') {
                await this.reportCompilationError(result.message);
                return;
            }
            this.output.appendLine(
                '[info] Compilation rapide indisponible sur ce poste, repli sur « dotnet build ».'
            );
        }

        // 3. Repli : MSBuild.
        await this.buildWithMsBuild(hash, framework);
    }

    async buildWithMsBuild(hash, framework) {
        let cancelled = false;
        try {
            const alreadyRestored = await this.ensureProjectExists(framework);
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "🔄 Compilation et exécution",
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: 'Compilation...' });
                const args = [
                    'build', this.projectFile,
                    '--nologo', '-v:quiet', '-consoleloggerparameters:NoSummary', '-tl:off'
                ];
                // Le restore implicite coûte plus d'une seconde à chaque appel :
                // on ne le refait que lorsque le projet vient de changer.
                if (alreadyRestored) { args.push('--no-restore'); }
                await this.executeDotnet(args, token);
                if (token.isCancellationRequested) { cancelled = true; }
            });
            if (cancelled) { return; }

            this.projectReady = true;
            const dll = this.getAssemblyPath(framework);
            this.writeCache({ hash, dll, framework });
            await this.runProgram(dll);
        } catch (error) {
            if (error.message !== 'cancelled') {
                await this.reportCompilationError(error.message);
            }
        }
    }

    async reportCompilationError(message) {
        vscode.window.showErrorMessage(`Erreur lors de la compilation du code: ${message}`);
        this.output.appendLine(`\n[ERREUR DE COMPILATION]\n${message}`);
        await this.handleError(this.csharpCodeFile, this.translatedCode, 'code c#');
    }

    /** Chemin de l'assembly produite par MSBuild pour le framework donné. */
    getAssemblyPath(framework) {
        return path.join(this.tempAppDir, 'bin', 'Debug', framework, 'tempApp.dll');
    }

    async runProgram(assembly) {
        return new Promise((resolve, reject) => {
            // On lance directement l'assembly plutôt que `dotnet run` : cela évite
            // que la sortie de MSBuild ne se mélange à celle du programme (ce qui
            // fausserait la détection du marqueur de saisie) et ne dépend pas du
            // comportement de `dotnet run`, qui évolue d'une version à l'autre.
            this.currentProcess = spawn(this.dotnetPath, [assembly], {
                cwd: path.dirname(assembly),
                env: DOTNET_ENV
            });

            let buffer = '';
            this.currentProcess.stdout.on('data', async (data) => {
                const output = data.toString();
                buffer += output;
                this.output.append(output);

                if (buffer.includes('\u200B')) {
                    buffer = '';

                    try {
                        // Utiliser la version avec disposition explicite
                        const inputResult = await this.createInputBoxWithDispose();

                        // Si l'exécution a été arrêtée pendant l'attente de saisie
                        if (!this.currentProcess || !this.currentProcess.stdin.writable) {
                            resolve();
                            return;
                        }

                        // Envoyer la valeur saisie au processus
                        if (inputResult !== undefined) {
                            this.currentProcess.stdin.write(inputResult + '\n');
                        } else {
                            // Si l'utilisateur a annulé l'input, on arrête l'exécution
                            this.stopExecution();
                            resolve();
                        }
                    } catch (error) {
                        this.stopExecution();
                        reject(error);
                    }
                }
            });

            this.currentProcess.stderr.on('data', (data) => {
                const errorMsg = data.toString();
                this.output.appendLine(`\n[ERREUR] ${errorMsg}`);
                fs.writeFileSync(path.join(this.tempAppDir, 'errorLog.txt'), errorMsg, 'utf8');
                vscode.window.showErrorMessage("Erreur lors de l'exécution du code");
            });

            this.currentProcess.on('close', (code) => {
                this.currentProcess = null;
                this.stopButton.hide();
                if (code === 0 || code === null) {
                    this.output.appendLine("\n[Exécution terminée]");
                    resolve();
                } else if (code !== null) {
                    this.output.appendLine(`\n[Exécution terminée avec le code ${code}]`);
                    reject(new Error(`Process exited with code ${code}`));
                }
            });

            this.currentProcess.on('error', (error) => {
                this.output.appendLine(`\n[ERREUR] ${error.message}`);
                this.currentProcess = null;
                this.stopButton.hide();
                reject(error);
            });
        });
    }

    async createInputBoxWithDispose() {
        // Création d'un InputBox que nous pouvons fermer explicitement
        return new Promise((resolve) => {
            // Création d'un InputBox standard
            const inputBox = vscode.window.createInputBox();
            this.currentInputBox = inputBox; // Stocke la référence

            inputBox.prompt = 'Entrez une valeur';
            inputBox.placeholder = 'Tapez votre réponse ici';
            inputBox.ignoreFocusOut = true;

            let result = undefined;

            inputBox.onDidAccept(() => {
                result = inputBox.value;
                inputBox.dispose();
                this.currentInputBox = null;
                resolve(result);
            });

            inputBox.onDidHide(() => {
                this.currentInputBox = null;
                resolve(result); // Peut être undefined si l'utilisateur a fermé sans accepter
            });

            inputBox.show();
        });
    }

    async handleError(filePath, content, name) {
        try {
            fs.writeFileSync(filePath, content, 'utf8');
            const openFile = await vscode.window.showWarningMessage(
                `Le fichier : ${name} a été sauvegardé. Voulez-vous l'ouvrir?`,
                'Oui', 'Non'
            );

            if (openFile === 'Oui') {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
            }
        } catch (writeError) {
            vscode.window.showErrorMessage(`Erreur lors de la sauvegarde du fichier: ${writeError.message}`);
        }
    }

    generateProgramContent(translatedCode) {
        return `
using System;
using System.Text;

class Program {
    static Program() {
        // Sous VS Code l'entrée/sortie est redirigée ; fixer l'encodage peut alors
        // échouer. Cet échec ne doit pas empêcher le programme de démarrer.
        try {
            Console.OutputEncoding = Encoding.UTF8;
            Console.InputEncoding = Encoding.UTF8;
        } catch (Exception) {
            // encodage par défaut conservé
        }
    }
    ${translatedCode}

    public static int Addition(params object[] obj)
    {
        int somme = 0;
        foreach (var objInstance in obj)
        {
            if (objInstance is not int)
            {
                throw new Exception("Une valeur non entière a été détectée dans l'addition");
            }
            somme += (int)objInstance;
        }
        return somme;
    }
}`;
    }

    /**
     * Lance `dotnet` avec des arguments (pas de shell : ni chemin à échapper,
     * ni `&&` incompatible avec PowerShell). MSBuild écrivant ses erreurs sur
     * stdout, les deux flux sont combinés dans le message d'erreur — sinon
     * celui-ci arrivait vide à l'utilisateur.
     */
    async executeDotnet(args, token) {
        return new Promise((resolve, reject) => {
            const childProcess = spawn(this.dotnetPath, args, {
                cwd: this.tempAppDir,
                env: DOTNET_ENV,
                shell: false
            });
            let stdout = '';
            let stderr = '';

            token?.onCancellationRequested(() => {
                childProcess.kill();
                reject(new Error('cancelled'));
            });

            childProcess.stdout.on('data', (data) => { stdout += data; });
            childProcess.stderr.on('data', (data) => { stderr += data; });

            childProcess.on('error', (error) => {
                reject(new Error(
                    `Impossible de lancer « ${this.dotnetPath} » : ${error.message}. ` +
                    `Vérifiez que le SDK .NET est installé et accessible.`
                ));
            });

            childProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    const details = [stderr, stdout]
                        .map(s => s.trim())
                        .filter(Boolean)
                        .join('\n');
                    reject(new Error(details || `Process exited with code ${code}`));
                }
            });
        });
    }
}

// --- Verrou sur les completions par IA ----------------------------------
// L'extension contribue des valeurs par defaut qui coupent le ghost text sur
// les fichiers .pseudo, mais un defaut contribue cede devant un reglage
// explicite. Deux mecanismes le rendent contraignant :
//   - le scellement, qui repose le verrou au plus haut niveau necessaire des
//     qu'une completion redevient active sur un fichier .pseudo ;
//   - le blocage de l'execution, qui s'appuie sur le fait que l'extension est
//     le seul moyen d'interpreter du pseudo-code : pas de verrou, pas de F5.
const AI_EXTENSIONS = [
    { id: 'GitHub.copilot', label: 'GitHub Copilot' },
    { id: 'GitHub.copilot-chat', label: 'GitHub Copilot Chat' },
    { id: 'Codeium.codeium', label: 'Codeium' },
    { id: 'Windsurf.windsurf', label: 'Windsurf' },
    { id: 'TabNine.tabnine-vscode', label: 'Tabnine' },
    { id: 'Continue.continue', label: 'Continue' },
    { id: 'sourcegraph.cody-ai', label: 'Cody' },
    { id: 'Supermaven.supermaven', label: 'Supermaven' },
    { id: 'AmazonWebServices.amazon-q-vscode', label: 'Amazon Q' },
    { id: 'Blackboxapp.blackbox', label: 'BLACKBOX AI' },
    { id: 'VisualStudioExptTeam.vscodeintellicode', label: 'IntelliCode' }
];

class AiGuard {

    constructor(context) {
        this.sealing = false;
        this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.item.command = 'pseudocode.diagnosticIA';
        context.subscriptions.push(
            this.item,
            vscode.window.onDidChangeActiveTextEditor(() => this.reseal()),
            vscode.workspace.onDidChangeConfiguration(event => {
                // Le drapeau evite de reagir a nos propres ecritures.
                if (this.sealing) { return; }
                if (event.affectsConfiguration('editor.inlineSuggest')
                    || event.affectsConfiguration('github.copilot')) {
                    this.reseal();
                }
            })
        );
        this.reseal();
    }

    detectExtensions() {
        return AI_EXTENSIONS
            .filter(candidate => vscode.extensions.getExtension(candidate.id))
            .map(candidate => candidate.label);
    }

    // Lecture dans la portee du langage : c'est la valeur que l'editeur
    // applique reellement au fichier .pseudo ouvert, defauts contribues inclus.
    isInlineEnabled(document) {
        return vscode.workspace
            .getConfiguration('editor', document)
            .get('inlineSuggest.enabled') === true;
    }

    audit(document) {
        const extensions = this.detectExtensions();
        const inline = this.isInlineEnabled(document);
        return { extensions, inline, exposed: inline && extensions.length > 0 };
    }

    // Tant que la valeur effective est correcte, rien n'est ecrit : le cas
    // normal, ou le defaut contribue suffit, ne touche aucun fichier de
    // reglages. Sinon on ecrit l'override de langage a l'echelon utilisateur,
    // puis workspace, puis dossier, en s'arretant des que le verrou tient :
    // un reglage de portee superieure ne peut donc pas le contourner.
    async seal(document) {
        if (this.sealing || !document || document.languageId !== 'pseudocode') { return; }
        if (!this.isInlineEnabled(document)) { return; }

        this.sealing = true;
        try {
            const scopes = [vscode.ConfigurationTarget.Global];
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length) {
                scopes.push(vscode.ConfigurationTarget.Workspace, vscode.ConfigurationTarget.WorkspaceFolder);
            }

            for (const scope of scopes) {
                try {
                    await vscode.workspace
                        .getConfiguration('editor', document)
                        .update('inlineSuggest.enabled', false, scope, true);
                } catch {
                    continue;   // portee indisponible dans cette fenetre
                }
                if (!this.isInlineEnabled(document)) { break; }
            }

            try {
                const copilot = vscode.workspace.getConfiguration('github.copilot');
                const enable = Object.assign({}, copilot.get('enable') || {}, { pseudocode: false });
                await copilot.update('enable', enable, vscode.ConfigurationTarget.Global);
            } catch {
                // Copilot n'est pas installe : son reglage n'existe pas.
            }
        } finally {
            this.sealing = false;
        }
    }

    async reseal() {
        await this.seal(vscode.window.activeTextEditor?.document);
        this.refresh();
    }

    refresh() {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== 'pseudocode') {
            this.item.hide();
            return;
        }

        const report = this.audit(document);
        if (report.exposed) {
            this.item.text = '$(warning) IA active';
            this.item.tooltip = `Complétion par IA active sur ce fichier (${report.extensions.join(', ')}). `
                + 'L\'exécution du pseudo-code est bloquée.';
            this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        } else {
            this.item.text = '$(shield) Sans IA';
            this.item.tooltip = report.extensions.length
                ? `Complétion par IA neutralisée sur les fichiers .pseudo (détecté : ${report.extensions.join(', ')}).`
                : 'Aucune extension de complétion par IA détectée.';
            this.item.backgroundColor = undefined;
        }
        this.item.show();
    }

    // Appelee avant chaque execution. L'extension etant le seul interpreteur
    // du pseudo-code, un refus ici est la sanction la plus concrete : l'eleve
    // ne peut pas tester son algorithme.
    async allowExecution(document) {
        await this.seal(document);
        this.refresh();

        const report = this.audit(document);
        if (!report.exposed) { return true; }

        await vscode.window.showErrorMessage(
            'Exécution bloquée : une complétion par IA reste active sur ce fichier '
            + `(${report.extensions.join(', ')}), et le verrou n'a pas pu être rétabli. `
            + 'Prévenez votre enseignant.',
            { modal: true });
        return false;
    }
}

function activate(context) {
    const projectManager = new CSharpProjectManager(context);
    const aiGuard = new AiGuard(context);

    // Préchauffage en tâche de fond : l'extension n'étant activée qu'à
    // l'ouverture d'un fichier .pseudo, le coût est engagé au bon moment.
    projectManager.warmUp();

    let runCommand = vscode.commands.registerCommand('pseudocode.run', async () => {

        let editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId !== 'pseudocode') {
            editor = vscode.window.visibleTextEditors.find(x => x.document?.languageId === 'pseudocode');
            if (editor) {
                await vscode.window.showTextDocument(editor.document);
            }
        }

        if (editor) {
            if (!await aiGuard.allowExecution(editor.document)) { return; }
            await projectManager.execute(editor.document.getText());
        } else {
            vscode.window.showErrorMessage('Pas de pseudocode à exécuter !');
        }
    });

    let stopCommand = vscode.commands.registerCommand('pseudocode.stop', () => {
        projectManager.stopExecution();
    });

    let diagnosticCommand = vscode.commands.registerCommand('pseudocode.diagnosticIA', async () => {
        const document = vscode.window.activeTextEditor?.document;
        await aiGuard.seal(document);
        aiGuard.refresh();

        const report = aiGuard.audit(document);
        const found = report.extensions.length ? report.extensions.join(', ') : 'aucune';

        if (report.exposed) {
            vscode.window.showErrorMessage(
                `Complétion par IA toujours active (${found}) : le verrou n'a pas pu être rétabli, ` +
                'et l\'exécution du pseudo-code restera bloquée.');
        } else {
            vscode.window.showInformationMessage(
                `Verrou en place : aucune complétion par IA n'est active sur les fichiers .pseudo. ` +
                `Extensions détectées : ${found}.`);
        }
    });

    context.subscriptions.push(runCommand, stopCommand, diagnosticCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
