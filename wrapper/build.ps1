# Builds wrapper\entomatical-claude.exe (the launcher that starts entomatical-claude.js with node) and wrapper\entomatical-rec.exe
# (the dictation recorder) with the C# compiler that ships with Windows (.NET Framework 4.x).
$ErrorActionPreference = "Stop"
$dist = Join-Path (Split-Path $PSScriptRoot) "dist"
$recordPath = Join-Path $dist "native-wrapper-build.proof"
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$build = New-Item -ItemType Directory -Path (Join-Path $dist ([guid]::NewGuid().ToString("N")))
try {
    $record = @{directory = $PSScriptRoot}
    $record["wrapper/build.ps1"] = (Get-FileHash -LiteralPath $PSCommandPath).Hash.ToLowerInvariant()
    $targets = [ordered]@{"launcher.cs" = "entomatical-claude.exe"; "recorder.cs" = "entomatical-rec.exe"}
    foreach ($source in $targets.Keys) {
        $inputFile = Join-Path $build.FullName $source
        $exe = $targets[$source]
        $outputFile = Join-Path $build.FullName $exe
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $source) -Destination $inputFile
        & $csc /nologo /optimize /target:exe "/out:$outputFile" $inputFile
        if ($LASTEXITCODE -ne 0) { throw "csc failed on $source with exit code $LASTEXITCODE" }
        $record["wrapper/$source"] = (Get-FileHash -LiteralPath $inputFile).Hash.ToLowerInvariant()
        $record["wrapper/$exe"] = (Get-FileHash -LiteralPath $outputFile).Hash.ToLowerInvariant()
    }
    $sealed = ConvertTo-SecureString ($record | ConvertTo-Json -Compress) -AsPlainText -Force
    $proof = Join-Path $build.FullName "build.proof"
    [IO.File]::WriteAllText($proof, (ConvertFrom-SecureString $sealed))
    foreach ($exe in $targets.Values) {
        Copy-Item -LiteralPath (Join-Path $build.FullName $exe) -Destination (Join-Path $PSScriptRoot $exe) -Force
    }
    [IO.File]::Move($proof, $recordPath, $true)
} finally {
    Remove-Item -LiteralPath $build.FullName -Recurse -Force
}
