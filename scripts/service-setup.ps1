<#
.SYNOPSIS
    Installs (or removes) tterm-connect as a Windows service running under a
    named user account.

.DESCRIPTION
    Must be run from an elevated PowerShell session.

    scripts/service-generate.js writes the winsw wrapper and its descriptor into
    ./daemon; this script then

      * registers the service,
      * grants the account the "Log on as a service" right,
      * sets the logon account + password through the Service Control Manager,
        so the password is stored in LSA and never written to a file,
      * makes the SCM restart the service even on a clean non-zero exit,
      * tightens ACLs on daemon/ and service.config.json (both hold the device
        token, which is the key to a shell on this machine),
      * starts the service and reports its state.

    The endpoint URL and token are passed to the process as environment
    variables, so they never appear in the process command line.

.EXAMPLE
    .\scripts\service-setup.ps1

.EXAMPLE
    .\scripts\service-setup.ps1 -Uninstall
#>
[CmdletBinding()]
param(
    # Remove the service instead of installing it.
    [switch]$Uninstall,

    # Credentials for the service account. Prompted for if omitted.
    [System.Management.Automation.PSCredential]$Credential,

    # Skip the pre-flight password check (use if validation misreports, e.g.
    # for some Microsoft-account logins).
    [switch]$SkipCredentialCheck
)

$ErrorActionPreference = 'Stop'

# The script normally runs in its own elevated window; keep a transcript so the
# result is readable afterwards.
$transcript = Join-Path $env:TEMP "tterm-service-setup-$PID.log"
try { Start-Transcript -Path $transcript -Force | Out-Null } catch { }

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------- pre-flight ----------

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'This script must run elevated. Open PowerShell as Administrator and re-run it.'
}

$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'service.config.json'
if (-not (Test-Path $configPath)) { throw "Missing $configPath" }

$cfg = Get-Content $configPath -Raw | ConvertFrom-Json
$displayName = $cfg.serviceName
if ([string]::IsNullOrWhiteSpace($displayName)) { $displayName = 'tterm-connect' }

# Must match the id computed in service-generate.js.
$serviceName = ($displayName -replace '[^\w]', '').ToLower()
$daemonDir = Join-Path $root 'daemon'
$wrapperExe = Join-Path $daemonDir "$serviceName.exe"

$nodeExe = $cfg.nodePath
if ([string]::IsNullOrWhiteSpace($nodeExe)) { $nodeExe = (Get-Command node).Source }
if (-not (Test-Path $nodeExe)) { throw "node interpreter not found: $nodeExe" }

$account = "$($cfg.accountDomain)\$($cfg.accountName)"

# A local account linked to a Microsoft account authenticates as
# MicrosoftAccount\<email>, not <machine>\<name>. Both names resolve to the same
# SID, but only the MicrosoftAccount form is accepted at logon.
$logonCandidates = @([pscustomobject]@{ Domain = $cfg.accountDomain; User = $cfg.accountName })
$localUser = Get-LocalUser -Name $cfg.accountName -ErrorAction SilentlyContinue
if ($null -ne $localUser -and $localUser.PrincipalSource -eq 'MicrosoftAccount') {
    $msaEmail = $cfg.msaEmail
    if ([string]::IsNullOrWhiteSpace($msaEmail)) {
        $msaEmail = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\IdentityStore\LogonCache' -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).IdentityName } |
            Where-Object { $_ -like '*@*' } | Select-Object -First 1
    }
    if (-not [string]::IsNullOrWhiteSpace($msaEmail)) {
        $logonCandidates += [pscustomobject]@{ Domain = 'MicrosoftAccount'; User = $msaEmail }
    }
}

Write-Step "Service '$serviceName' (display name '$displayName')"
Write-Host "    root    : $root"
Write-Host "    node    : $nodeExe"
Write-Host "    account : $account"

function Wait-ForService([string]$name, [bool]$present, [int]$seconds = 30) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
        if ($present -and $null -ne $svc) { return $true }
        if ((-not $present) -and $null -eq $svc) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# ---------- uninstall ----------

if ($Uninstall) {
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -eq $existing) {
        Write-Ok 'Service is not installed. Nothing to do.'
        return
    }

    if ($existing.Status -ne 'Stopped') {
        Write-Step 'Stopping service'
        Stop-Service -Name $serviceName -Force
        $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
        Write-Ok 'Stopped.'
    }

    Write-Step 'Unregistering service'
    if (-not (Test-Path $wrapperExe)) { throw "Wrapper executable is missing: $wrapperExe" }
    & $wrapperExe uninstall
    if (-not (Wait-ForService $serviceName $false)) {
        Write-Warn 'Service is still registered - it will disappear after a reboot or once all handles to it are closed.'
    } else {
        Write-Ok 'Service removed.'
    }
    Write-Warn 'daemon/ and service.config.json were left in place - they still hold the device token.'
    return
}

# ---------- credentials ----------

if ($null -eq $Credential) {
    Write-Step "Windows password for $account"
    if ($logonCandidates.Count -gt 1) {
        Write-Host "    This account is linked to the Microsoft account $($logonCandidates[-1].User) -"
        Write-Host '    use that Microsoft account password, not a Windows Hello PIN.'
    }
    Write-Host '    Stored by the Service Control Manager in LSA - not written to any file.'
    $Credential = Get-Credential -UserName $account -Message "Windows password for $account"
}
if ($null -eq $Credential) { throw 'No credentials supplied.' }

$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Credential.Password)
try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

# ---------- "Log on as a service" right ----------

Write-Step 'Granting "Log on as a service" (SeServiceLogonRight)'
$sid = (New-Object Security.Principal.NTAccount($cfg.accountDomain, $cfg.accountName)).Translate([Security.Principal.SecurityIdentifier]).Value

$exportInf = Join-Path $env:TEMP 'tterm-rights-export.inf'
$importInf = Join-Path $env:TEMP 'tterm-rights-import.inf'
$rightsDb  = Join-Path $env:TEMP 'tterm-rights.sdb'
foreach ($f in @($exportInf, $importInf, $rightsDb)) {
    if (Test-Path $f) { Remove-Item $f -Force }
}

secedit /export /cfg $exportInf /areas USER_RIGHTS | Out-Null
if (-not (Test-Path $exportInf)) { throw 'secedit /export failed - could not read the current user rights.' }

$currentLine = Get-Content $exportInf | Where-Object { $_ -match '^SeServiceLogonRight\s*=' } | Select-Object -First 1
if ($null -eq $currentLine) {
    $newLine = "SeServiceLogonRight = *$sid"
} elseif ($currentLine -match [regex]::Escape($sid)) {
    $newLine = $null
    Write-Ok 'Right already granted.'
} else {
    $newLine = "$($currentLine.TrimEnd()),*$sid"
}

if ($null -ne $newLine) {
    # secedit reads and writes UTF-16; -Encoding Unicode matches.
    @(
        '[Unicode]'
        'Unicode=yes'
        '[Version]'
        'signature="$CHICAGO$"'
        'Revision=1'
        '[Privilege Rights]'
        $newLine
    ) | Set-Content -Path $importInf -Encoding Unicode

    secedit /configure /db $rightsDb /cfg $importInf /areas USER_RIGHTS | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "secedit /configure failed (exit $LASTEXITCODE). See $env:windir\security\logs\scesrv.log"
    }
    Write-Ok 'Right granted.'
}

# ---------- verify the credentials can actually log on as a service ----------

# Done here rather than earlier because a service logon needs SeServiceLogonRight
# to already be in place. LogonUser is the real thing the SCM will do; the
# managed ValidateCredentials() only checks the local SAM and always fails for
# Microsoft-account-linked users like this one.
if (-not $SkipCredentialCheck) {
    Write-Step 'Test service logon'
    if (-not ('TtermLogon' -as [type])) {
        Add-Type -Namespace '' -Name 'TtermLogon' -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern bool LogonUser(string user, string domain, string password,
    int logonType, int logonProvider, out IntPtr token);

[DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(IntPtr handle);
'@
    }

    $logonOk = $false
    $lastError = 0
    foreach ($candidate in $logonCandidates) {
        $token = [IntPtr]::Zero
        # LOGON32_LOGON_SERVICE = 5, LOGON32_PROVIDER_DEFAULT = 0
        $logonOk = [TtermLogon]::LogonUser($candidate.User, $candidate.Domain, $plainPassword, 5, 0, [ref]$token)
        $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($token -ne [IntPtr]::Zero) { [void][TtermLogon]::CloseHandle($token) }
        if ($logonOk) {
            $account = "$($candidate.Domain)\$($candidate.User)"
            break
        }
        Write-Warn "$($candidate.Domain)\$($candidate.User): rejected (error $lastError)"
    }

    if (-not $logonOk) {
        $hints = @{
            1326 = 'wrong user name or password'
            1327 = 'account restriction (blank passwords are not allowed for service logons)'
            1330 = 'the password has expired'
            1331 = 'the account is disabled'
            1385 = 'the account is not allowed to log on as a service'
            1907 = 'the password must be changed before first logon'
        }
        $hint = $hints[[int]$lastError]
        if ($null -eq $hint) { $hint = 'see the Win32 error code' }
        $tried = ($logonCandidates | ForEach-Object { "$($_.Domain)\$($_.User)" }) -join ', '
        throw ("Service logon failed for every account name tried ($tried); last error $lastError - $hint. " +
               'A service logon needs the account password itself - a Windows Hello PIN will not work, and ' +
               'for a Microsoft account it is the password you use at account.microsoft.com. Re-run with ' +
               '-SkipCredentialCheck to install anyway.')
    }
    Write-Ok "$account can log on as a service."
}

# ---------- generate daemon files ----------

Write-Step 'Generating the winsw wrapper and descriptor'
$wasRunning = $false
$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $existing -and $existing.Status -ne 'Stopped') {
    # The wrapper exe cannot be overwritten while it is running.
    $wasRunning = $true
    Stop-Service -Name $serviceName -Force
    $existing.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    Write-Ok 'Stopped the running service first.'
}

& $nodeExe (Join-Path $PSScriptRoot 'service-generate.js')
if ($LASTEXITCODE -ne 0) { throw "service-generate.js failed (exit $LASTEXITCODE)" }
if (-not (Test-Path $wrapperExe)) { throw "Wrapper executable was not generated: $wrapperExe" }
Write-Ok "Wrote $daemonDir"

# ---------- register ----------

if ($null -eq (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
    Write-Step 'Registering the service'
    & $wrapperExe install
    if (-not (Wait-ForService $serviceName $true)) {
        throw "Service '$serviceName' was not registered. Check $daemonDir for the wrapper log."
    }
    Write-Ok 'Registered.'
} else {
    Write-Ok 'Service already registered - reconfiguring it.'
}

# ---------- logon account + startup type ----------

Write-Step 'Setting the logon account'
# Invoke-CimMethod keeps the password in-process; sc.exe would expose it in the
# command line of a process any user can enumerate.
$svcObject = Get-CimInstance -ClassName Win32_Service -Filter "Name='$serviceName'"
$change = Invoke-CimMethod -InputObject $svcObject -MethodName Change -Arguments @{
    StartName     = $account
    StartPassword = $plainPassword
    StartMode     = 'Automatic'
}
$plainPassword = $null
if ($change.ReturnValue -ne 0) {
    $reasons = @{
        2  = 'Access denied'
        15 = 'Service dependency failure'
        21 = 'Invalid parameter'
        22 = 'Invalid service account'
        24 = 'Service not found'
    }
    $why = $reasons[[int]$change.ReturnValue]
    if ($null -eq $why) { $why = 'see Win32_Service::Change return codes' }
    throw "Could not set the logon account (return $($change.ReturnValue): $why)."
}
Write-Ok "Runs as $account, start type Automatic."

# ---------- restart on a clean exit too ----------

# The restart delays themselves come from <onfailure> in the descriptor, which
# winsw wrote into the SCM at install time. failureflag additionally applies
# them when the process exits without a "crash" exit code.
Write-Step 'Configuring auto-restart'
sc.exe failureflag $serviceName 1 | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warn "sc.exe failureflag returned $LASTEXITCODE" }
Write-Ok 'Restarts after 5s, 20s, then 60s; failure count resets hourly.'

# ---------- lock down the token ----------

Write-Step 'Restricting access to the device token'
# daemon\<service>.xml and service.config.json both contain the token, which is
# the key to a shell on this machine.
# Granted by SID: the account may be named MicrosoftAccount\<email>, which
# icacls does not resolve.
icacls $daemonDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' "*${sid}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warn "icacls on $daemonDir returned $LASTEXITCODE" }
icacls $configPath /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' "*${sid}:R" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Warn "icacls on $configPath returned $LASTEXITCODE" }
Write-Ok 'Readable only by SYSTEM, Administrators and the service account.'

# ---------- start ----------

Write-Step 'Starting the service'
Start-Service -Name $serviceName
$svc = Get-Service -Name $serviceName
$svc.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Write-Ok "Status: $($svc.Status)"
if ($wasRunning) { Write-Ok 'Restarted with the new configuration.' }

Start-Sleep -Seconds 5
$outLog = Get-ChildItem -Path $daemonDir -Filter '*.out.log' -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($null -ne $outLog) {
    Write-Step "Recent output ($($outLog.Name))"
    Get-Content $outLog.FullName -Tail 20 | ForEach-Object { Write-Host "    $_" }
} else {
    Write-Warn "No output log in $daemonDir yet."
}

Write-Host ''
Write-Host 'Done. Manage it with:' -ForegroundColor Cyan
Write-Host "    Get-Service $serviceName"
Write-Host "    Restart-Service $serviceName"
Write-Host "    Get-Content '$daemonDir\$serviceName.out.log' -Tail 50 -Wait"
Write-Host '    .\scripts\service-setup.ps1 -Uninstall'
try { Stop-Transcript | Out-Null } catch { }
