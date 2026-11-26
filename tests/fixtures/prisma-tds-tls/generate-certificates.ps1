$ErrorActionPreference = 'Stop'
# Disposable test identities only; never add this CA to a system trust store.
$output = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'certificates'))
if (Test-Path -LiteralPath $output) { throw 'Refusing to overwrite certificate fixtures' }
[IO.Directory]::CreateDirectory($output) | Out-Null
$hash = [Security.Cryptography.HashAlgorithmName]::SHA256
$padding = [Security.Cryptography.RSASignaturePadding]::Pkcs1
$rootKey = [Security.Cryptography.RSA]::Create(2048)
$rootRequest = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=Oja isolated TLS fixture CA', $rootKey, $hash, $padding)
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new([Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign, $true))
$rootRequest.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($rootRequest.PublicKey, $false))
$root = $rootRequest.CreateSelfSigned([DateTimeOffset]'2020-01-01T00:00:00Z', [DateTimeOffset]'2040-01-01T00:00:00Z')
try {
    [IO.File]::WriteAllBytes((Join-Path $output 'root.der'), $root.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
    $cases = @(
        @{ Name = 'valid'; From = '2020-01-02T00:00:00Z'; Until = '2036-01-01T00:00:00Z' },
        @{ Name = 'expired'; From = '2020-01-02T00:00:00Z'; Until = '2021-01-01T00:00:00Z' },
        @{ Name = 'future'; From = '2037-01-01T00:00:00Z'; Until = '2038-01-01T00:00:00Z' }
    )
    foreach ($case in $cases) {
        $key = [Security.Cryptography.RSA]::Create(2048)
        $request = [Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=tds.fixture.invalid', $key, $hash, $padding)
        $san = [Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
        $san.AddDnsName('tds.fixture.invalid')
        $request.CertificateExtensions.Add($san.Build())
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
        $usage = [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($usage, $true))
        $oids = [Security.Cryptography.OidCollection]::new()
        $oids.Add([Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1')) | Out-Null
        $request.CertificateExtensions.Add([Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $true))
        $serial = [byte[]]::new(16)
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $rng.GetBytes($serial)
        $rng.Dispose()
        $cert = $request.Create($root, [DateTimeOffset]$case.From, [DateTimeOffset]$case.Until, $serial)
        $withKey = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($cert, $key)
        try {
            [IO.File]::WriteAllBytes((Join-Path $output ($case.Name + '.der')), $cert.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert))
            $collection = [Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
            $collection.Add($withKey) | Out-Null
            $publicRoot = [Security.Cryptography.X509Certificates.X509Certificate2]::new($root.RawData)
            $collection.Add($publicRoot) | Out-Null
            [IO.File]::WriteAllBytes((Join-Path $output ($case.Name + '.pfx')), $collection.Export([Security.Cryptography.X509Certificates.X509ContentType]::Pkcs12, 'synthetic-fixture-only'))
            $publicRoot.Dispose()
        } finally { $withKey.Dispose(); $cert.Dispose(); $key.Dispose() }
    }
} finally { $root.Dispose(); $rootKey.Dispose() }
Write-Output 'Created isolated certificate fixtures; no trust-store changes.'
