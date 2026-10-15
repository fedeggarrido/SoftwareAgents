# Retira un worktree de .worktrees/ sin seguir sus enlaces de directorio.
#
# En Windows, `git worktree remove` sigue junctions y symlinks de directorio. Los
# node_modules de los worktrees son junctions al repo principal, y su node_modules
# contiene los enlaces de workspaces de npm (pixel-agents -> server,
# webview-ui -> webview-ui). Si queda uno, git vacía el node_modules real y borra
# server/ y webview-ui/ del checkout principal (incidente del 2026-10-03).
#
# Este script quita cada enlace (solo el enlace, nunca su destino), comprueba que
# no queda ninguno y solo entonces llama a git. Ante cualquier duda, falla sin borrar.
#
#   powershell -NoProfile -File scripts/remove-worktree.ps1 -Path .worktrees/SA-074
param([Parameter(Mandatory = $true)][string]$Path, [switch]$DiscardChanges)
$ErrorActionPreference = 'Stop'

$commonDir = git rev-parse --path-format=absolute --git-common-dir
if ($LASTEXITCODE) { throw 'No es un repositorio git' }
$repo = Split-Path -Parent ([System.IO.Path]::GetFullPath($commonDir))
$worktrees = [System.IO.Path]::GetFullPath((Join-Path $repo '.worktrees')).TrimEnd('\') + '\'
$target = [System.IO.Path]::GetFullPath($(if ([System.IO.Path]::IsPathRooted($Path)) { $Path } else { Join-Path $repo $Path })).TrimEnd('\')
if (-not $target.StartsWith($worktrees, [StringComparison]::OrdinalIgnoreCase) -or $target.Length -le $worktrees.Length) {
  throw "Solo se retiran worktrees bajo $worktrees (recibido: $target)"
}
if (-not (Test-Path -LiteralPath $target -PathType Container)) { throw "No existe: $target" }

# Enlaces de directorio bajo $dir, sin descender por ninguno de ellos.
function Find-DirectoryLinks([string]$dir) {
  foreach ($child in [System.IO.Directory]::EnumerateDirectories($dir)) {
    if ([System.IO.File]::GetAttributes($child) -band [System.IO.FileAttributes]::ReparsePoint) {
      $child
    } else {
      Find-DirectoryLinks $child
    }
  }
}

foreach ($link in @(Find-DirectoryLinks $target)) {
  # Non-recursive delete of a reparse point removes the link and leaves its target intact.
  [System.IO.Directory]::Delete($link, $false)
  Write-Output "enlace retirado: $link"
}
$left = @(Find-DirectoryLinks $target)
if ($left.Count) { throw "Quedan enlaces; no se llama a git: $($left -join ', ')" }

if ($DiscardChanges) {
  git -C $repo worktree remove --force $target
} else {
  git -C $repo worktree remove $target
}
if ($LASTEXITCODE) { throw "git worktree remove falló ($LASTEXITCODE); el worktree no tiene enlaces, revísalo a mano" }
Write-Output "worktree retirado: $target"
