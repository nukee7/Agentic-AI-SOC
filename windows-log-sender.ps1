# windows-log-sender.ps1
#
# Reads Windows Security Event Log and forwards events to the SOC producer.
# Run this script on your Windows host (NOT inside Docker).
# Run as Administrator to access the Security event log.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File windows-log-sender.ps1
#
# Event IDs:
#   4625 = Failed login
#   4624 = Successful login
#   4648 = Login with explicit credentials

$INGEST_URL    = "http://localhost:3001/ingest"
$POLL_INTERVAL = 5
$lookbackMins  = 5

$lastEventTime = (Get-Date).AddMinutes(-$lookbackMins)

Write-Host "Windows Security Log Sender"
Write-Host "Sending to: $INGEST_URL"
Write-Host "Polling every ${POLL_INTERVAL}s - Press Ctrl+C to stop"
Write-Host ""

function Send-SecurityEvent($payload) {
    try {
        $body = $payload | ConvertTo-Json -Compress -Depth 5
        Invoke-RestMethod -Uri $INGEST_URL -Method POST -Body $body -ContentType "application/json" | Out-Null
        $sev = $payload.severity.ToUpper()
        $msg = $payload.message
        Write-Host "[$sev] $msg"
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "[ERROR] Failed to send event: $errMsg"
    }
}

function Get-DataField($dataNodes, $fieldName) {
    $node = $dataNodes | Where-Object { $_.Name -eq $fieldName }
    if ($node) { return $node.'#text' } else { return $null }
}

while ($true) {
    try {
        $events = Get-WinEvent -FilterHashtable @{
            LogName   = "Security"
            Id        = 4624, 4625, 4648
            StartTime = $lastEventTime
        } -ErrorAction SilentlyContinue

        if ($events) {
            $sorted = $events | Sort-Object TimeCreated

            foreach ($e in $sorted) {
                $xml  = [xml]$e.ToXml()
                $data = $xml.Event.EventData.Data

                $username  = Get-DataField $data "TargetUserName"
                $domain    = Get-DataField $data "TargetDomainName"
                $sourceIp  = Get-DataField $data "IpAddress"
                $logonType = Get-DataField $data "LogonType"

                if (!$username -or $username -match '\$$') { continue }
                if (!$sourceIp -or $sourceIp -eq "-" -or $sourceIp -eq "::1") {
                    $sourceIp = "127.0.0.1"
                }

                $fullUser = if ($domain -and $domain -ne "-") { "$domain\$username" } else { $username }

                $severity = "info"
                $message  = ""
                $rawLog   = ""

                switch ($e.Id) {
                    4625 {
                        $severity = "warning"
                        $message  = "Failed login for $fullUser from $sourceIp"
                        $rawLog   = "Windows Event 4625: Failed login. User: $fullUser IP: $sourceIp LogonType: $logonType"
                    }
                    4624 {
                        $severity = "info"
                        $message  = "Successful login for $fullUser from $sourceIp"
                        $rawLog   = "Windows Event 4624: Successful login. User: $fullUser IP: $sourceIp LogonType: $logonType"
                    }
                    4648 {
                        $severity = "critical"
                        $message  = "Explicit credential use by $fullUser from $sourceIp"
                        $rawLog   = "Windows Event 4648: Explicit credential logon. User: $fullUser IP: $sourceIp"
                    }
                }

                $payload = @{
                    eventId   = [System.Guid]::NewGuid().ToString()
                    timestamp = $e.TimeCreated.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
                    host      = $env:COMPUTERNAME
                    service   = "windows-security"
                    logType   = "authentication"
                    severity  = $severity
                    sourceIp  = $sourceIp
                    username  = $username
                    message   = $message
                    rawLog    = $rawLog
                }

                Send-SecurityEvent $payload
            }

            $lastEventTime = ($sorted | Select-Object -Last 1).TimeCreated.AddSeconds(1)
        }
    } catch {
        $errMsg = $_.Exception.Message
        Write-Host "[WARN] Error reading event log: $errMsg"
    }

    Start-Sleep -Seconds $POLL_INTERVAL
}
