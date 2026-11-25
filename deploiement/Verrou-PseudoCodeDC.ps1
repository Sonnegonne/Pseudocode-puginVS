<#
.SYNOPSIS
  Verrouille la version de PseudoCodeDC sur un poste de l'école.

.DESCRIPTION
  Écrit la stratégie VS Code « AllowedExtensions » dans
  HKLM\SOFTWARE\Policies\Microsoft\VSCode. Cette stratégie s'applique à tous
  les comptes Windows du poste, et un élève sans droits administrateur ne peut
  pas la modifier.

  Effet : seules les versions de PseudoCodeDC listées dans $VersionsAutorisees
  peuvent être installées ou activées. Si un élève installe une ancienne
  version (0.3.0, 0.1.5…), VS Code la refuse ou la désactive.
  Copilot et les extensions d'IA tierces connues (Codeium, Tabnine…) sont
  aussi interdites. Toutes les autres extensions restent permises.

  L'IA intégrée à VS Code (Copilot livré avec l'éditeur) n'est pas une
  extension installée : elle est coupée par l'extension elle-même, via le
  réglage chat.disableAIFeatures (aucune stratégie n'existe pour lui).
  Le script pose en plus les stratégies machine qui existent (VS Code 1.99+) :
  mode agent coupé, serveurs MCP interdits, outils d'extensions et plugins
  du chat coupés.

  Exige VS Code 1.96 ou plus récent. À lancer en administrateur.

.PARAMETER Retirer
  Supprime le verrou (retour à la normale).

.PARAMETER Versions
  Versions de PseudoCodeDC à autoriser, à la place de $VersionsAutorisees
  (le script d'installation des postes élèves passe celle du .vsix livré).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\Verrou-PseudoCodeDC.ps1
  powershell -ExecutionPolicy Bypass -File .\Verrou-PseudoCodeDC.ps1 -Retirer
#>
param(
    [switch]$Retirer,
    [string[]]$Versions
)

# Versions de l'extension acceptées. À la sortie d'une nouvelle version,
# l'ajouter ici et relancer le script sur les postes.
$VersionsAutorisees = @('0.7.3')
if ($Versions) { $VersionsAutorisees = $Versions }

$Cle    = 'HKLM:\SOFTWARE\Policies\Microsoft\VSCode'
$Valeur = 'AllowedExtensions'

# Stratégies du chat de VS Code (noms relevés dans le VS Code 1.141)
$StrategiesChat = [ordered]@{
    ChatAgentMode           = 0        # chat.agent.enabled
    ChatAgentExtensionTools = 0        # chat.extensionToolsEnabled
    ChatPluginsEnabled      = 0        # chat.plugins.enabled
    ChatMCP                 = 'none'   # chat.mcp.access
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
         ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host "Ce script doit être lancé en administrateur (clic droit > Exécuter en tant qu'administrateur)." -ForegroundColor Red
    exit 1
}

if ($Retirer) {
    if (Test-Path $Cle) {
        Remove-ItemProperty -Path $Cle -Name (@($Valeur) + $StrategiesChat.Keys) -ErrorAction SilentlyContinue
    }
    Write-Host 'Verrou retiré. Redémarrez VS Code.' -ForegroundColor Yellow
    exit 0
}

# Le @() garantit un tableau JSON même avec une seule version.
$regle = [ordered]@{
    'pseudocode.pseudocodedc' = @($VersionsAutorisees)
    'github.copilot'          = $false
    'github.copilot-chat'     = $false
    'codeium.codeium'         = $false
    'windsurf.windsurf'       = $false
    'tabnine.tabnine-vscode'  = $false
    'continue.continue'       = $false
    'sourcegraph.cody-ai'     = $false
    'supermaven.supermaven'   = $false
    'amazonwebservices.amazon-q-vscode' = $false
    'blackboxapp.blackbox'    = $false
    'google.geminicodeassist' = $false
    'saoudrizwan.claude-dev'  = $false
    'rooveterinaryinc.roo-cline' = $false
    'anthropic.claude-code'   = $false
    'openai.chatgpt'          = $false
    '*'                       = $true
}
$json = $regle | ConvertTo-Json -Compress

if (-not (Test-Path $Cle)) {
    New-Item -Path $Cle -Force | Out-Null
}
New-ItemProperty -Path $Cle -Name $Valeur -Value $json -PropertyType String -Force | Out-Null
foreach ($n in $StrategiesChat.Keys) {
    $type = if ($StrategiesChat[$n] -is [int]) { 'DWord' } else { 'String' }
    New-ItemProperty -Path $Cle -Name $n -Value $StrategiesChat[$n] -PropertyType $type -Force | Out-Null
}

$relu = (Get-ItemProperty -Path $Cle -Name $Valeur).$Valeur
Write-Host "Verrou posé :" -ForegroundColor Green
Write-Host "  $Cle\$Valeur = $relu"
Write-Host "  Chat : mode agent, MCP, outils et plugins coupes."
Write-Host ''
Write-Host 'Fermez puis rouvrez VS Code pour que la règle soit prise en compte.'
