const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CONFIG = {
    sdkVersion: '9.0.101',
    dotnetFrameworkVersion: 'net9.0',
    tempDirectoryName: 'tempApp',
    typeMapping: {
        "entier": "int",
        "chaine de caracteres": "string",
        "caracteres": "string",
        "numerique": "double",
        "booleen": "bool"
    }
};

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
        this.tempAppDir = path.join(context.extensionPath, CONFIG.tempDirectoryName);
        this.projectFile = path.join(this.tempAppDir, 'tempApp.csproj');
        this.programFile = path.join(this.tempAppDir, 'Program.cs');
        this.csharpCodeFile = path.join(this.tempAppDir, 'CSharpCode.txt');
        this.currentProcess = null;
        this.currentInputBox = null;
        this.stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
        this.stopButton.text = "$(debug-stop) Stop Execution";
        this.stopButton.command = 'pseudocode.stop';
        context.subscriptions.push(this.stopButton);
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
            await this.ensureProjectExists();
            await this.buildAndRun(translatedCode);
        } catch (error) {
            vscode.window.showErrorMessage(`Erreur de compilation : ${error.message}`);
        } finally {
            this.stopButton.hide();
        }
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
                console.error('Erreur lors de l\'arrêt du processus:', error);
                this.stopButton.hide();
                this.currentProcess = null;
                this.currentInputBox = null;
            }
        }
    }

    async ensureProjectExists() {
        if (!fs.existsSync(this.tempAppDir)) {            
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Création du projet C#",
                cancellable: false
            }, async () => {
                fs.mkdirSync(this.tempAppDir, { recursive: true });
                //await this.executeCommand(`dotnet new globaljson --sdk-version ${CONFIG.sdkVersion}`);
                await this.executeCommand(`dotnet new console -o "${this.tempAppDir}" -f "${CONFIG.dotnetFrameworkVersion}" --force`);
            });
        }
    }

    async buildAndRun(translatedCode) {
        this.translatedCode = translatedCode;
        const programContent = this.generateProgramContent(translatedCode);
        fs.writeFileSync(this.programFile, programContent, 'utf8');
        fs.writeFileSync(this.csharpCodeFile, translatedCode, 'utf8');

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "🔄 Compilation et exécution",
                cancellable: true
            }, async (progress, token) => {
                progress.report({ message: 'Compilation...' });
                await this.executeCommand(`cd "${this.tempAppDir}" && dotnet build`, token);
                if (token.isCancellationRequested) {
                    return;
                }
            });
            await this.runProgram();
        } catch (error) {
            if (error.message !== 'cancelled') {
                vscode.window.showErrorMessage(`Erreur lors de la compilation du code: ${error.message}`);
                await this.handleError(this.csharpCodeFile, this.translatedCode, 'code c#');
            }
        }
    }   

    async runProgram() {
        return new Promise((resolve, reject) => {
            this.currentProcess = spawn('dotnet', ['run'], { cwd: this.tempAppDir });
            
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
                vscode.window.showErrorMessage('Erreur lors de l\'exécution du code');
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
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;
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

    async executeCommand(command, token) {
        return new Promise((resolve, reject) => {
            const childProcess = spawn(command, { shell: true });
            let stdout = '';
            let stderr = '';

            token?.onCancellationRequested(() => {
                childProcess.kill();
                reject(new Error('cancelled'));
            });

            childProcess.stdout.on('data', (data) => {
                stdout += data;
            });

            childProcess.stderr.on('data', (data) => {
                stderr += data;
            });

            childProcess.on('close', (code) => {
                if (code === 0) {
                    resolve(stdout);
                } else {
                    reject(new Error(stderr || `Process exited with code ${code}`));
                }
            });
        });
    }
}

function activate(context) {
    const projectManager = new CSharpProjectManager(context);
    let runCommand = vscode.commands.registerCommand('pseudocode.run', async () => {

        let editor = vscode.window.activeTextEditor;
        if (editor && editor.document.languageId !== 'pseudocode') {
            editor = vscode.window.visibleTextEditors.find(x => x.document?.languageId === 'pseudocode');
            if (editor) {
                await vscode.window.showTextDocument(editor.document);
            }
        }
        
        if (editor) {
            await projectManager.execute(editor.document.getText());
        } else {
            vscode.window.showErrorMessage('Pas de pseudocode à exécuter !');
        }
    });

    let stopCommand = vscode.commands.registerCommand('pseudocode.stop', () => {
        projectManager.stopExecution();
    });

    context.subscriptions.push(runCommand, stopCommand);
}

function deactivate() {}

module.exports = { activate, deactivate };
