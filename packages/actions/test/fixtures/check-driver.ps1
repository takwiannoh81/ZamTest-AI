# Static checks for driver.ps1 that run on any OS with PowerShell 7:
# the PowerShell parses, and the embedded C# compiles as C# 5 against stub UI Automation types.
param([string]$Driver, [string]$Stub)
$tokens = $null; $errors = $null
[void][System.Management.Automation.Language.Parser]::ParseFile($Driver, [ref]$tokens, [ref]$errors)
foreach ($e in $errors) { "PS $($e.Extent.StartLineNumber): $($e.Message)" }

$src = Get-Content -Raw $Driver
$code = [regex]::Match($src, "(?s)\`$NativeSource = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
$jsonCode = [regex]::Match($src, "(?s)\`$JsonSource = @'\r?\n(.*?)\r?\n'@").Groups[1].Value
if (-not $code -or -not $jsonCode) { 'C#: embedded source not found'; exit 1 }
$opts = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::Default.WithLanguageVersion([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$trees = [Microsoft.CodeAnalysis.SyntaxTree[]]@(
  [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText((Get-Content -Raw $Stub), $opts),
  [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($code, $opts),
  [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($jsonCode, $opts)
)
$refs = [AppDomain]::CurrentDomain.GetAssemblies() | Where-Object { -not $_.IsDynamic -and $_.Location } |
  ForEach-Object { [Microsoft.CodeAnalysis.MetadataReference]::CreateFromFile($_.Location) }
$options = New-Object Microsoft.CodeAnalysis.CSharp.CSharpCompilationOptions([Microsoft.CodeAnalysis.OutputKind]::DynamicallyLinkedLibrary)
$compilation = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation]::Create('check', $trees, [Microsoft.CodeAnalysis.MetadataReference[]]$refs, $options)
$result = $compilation.Emit((New-Object System.IO.MemoryStream))
foreach ($d in $result.Diagnostics) { if ($d.Severity -eq 'Error') { "C# $d" } }
'DONE'
